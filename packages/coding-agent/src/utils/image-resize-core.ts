import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
	/**
	 * Re-encode an image whose base64 payload is above this many bytes even when its dimensions fit (screenshot PNGs
	 * are often several MB and a fraction of that as JPEG). Default: off (images within limits are sent as is).
	 */
	reencodeAboveBytes?: number;
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	/** Raw bytes of the input and of the image sent (base64 decoded). */
	originalBytes?: number;
	bytes?: number;
}

/**
 * Tag on image resize worker replies. Node can post its own messages on the worker channel
 * (for example `{ "watch:require": [...] }` under `node --watch`), so replies must be identifiable.
 */
export const IMAGE_RESIZE_WORKER_RESPONSE_TYPE = "runkiln:image-resize-response";

export type ResizeImageWorkerResponse =
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; result: ResizedImage | null }
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; error: string };

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<Omit<ImageResizeOptions, "reencodeAboveBytes">> & {
	reencodeAboveBytes: number | undefined;
} = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
	reencodeAboveBytes: undefined,
};

const rawBytes = (base64: string) =>
	Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * returns null.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		const unchanged = (): ResizedImage => ({
			data: Buffer.from(inputBytes).toString("base64"),
			mimeType: mimeType || `image/${format}`,
			originalWidth,
			originalHeight,
			width: originalWidth,
			height: originalHeight,
			wasResized: false,
			originalBytes: inputBytes.byteLength,
			bytes: inputBytes.byteLength,
		});
		// Check if already within all limits (dimensions AND encoded size), and small enough to send as is
		const fitsDimensions = originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight;
		const reencode = opts.reencodeAboveBytes !== undefined && inputBase64Size > opts.reencodeAboveBytes;
		if (fitsDimensions && inputBase64Size < opts.maxBytes && !reencode) return unchanged();

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		}

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const [png, preferredJpeg, ...lowerJpegs] = tryEncodings(currentWidth, currentHeight, qualitySteps);
			// PNG or JPEG at the target quality, whichever is smaller; then lower JPEG qualities.
			const first = [png, preferredJpeg].filter(Boolean).sort((a, b) => a.encodedSize - b.encodedSize);
			for (const candidate of [...first, ...lowerJpegs]) {
				if (candidate.encodedSize < opts.maxBytes) {
					// Re-encoding at the original size that saves nothing: keep the original.
					if (fitsDimensions && currentWidth === originalWidth && candidate.encodedSize >= inputBase64Size) {
						return unchanged();
					}
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
						originalBytes: inputBytes.byteLength,
						bytes: rawBytes(candidate.data),
					};
				}
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		if (image) {
			image.free();
		}
	}
}
