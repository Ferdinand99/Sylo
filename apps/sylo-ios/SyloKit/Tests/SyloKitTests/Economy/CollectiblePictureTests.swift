import Foundation
import Testing
@testable import SyloKit

#if canImport(ImageIO)
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// The conversion of a phone photo into a picture the server takes: HEIC, JPEG and PNG go in, a JPEG
/// (or a PNG with transparency) of at most 1024 pixels and under 2 MB comes out. Runs with the system's
/// own image tools, so the pictures are made in the tests.
@Suite("Collectible picture")
struct CollectiblePictureTests {
    /// A picture of `width` x `height` pixels. `noisy` fills it with random pixels, which compress badly
    /// and force the shrinking steps; otherwise a smooth gradient. `alpha` makes the left half transparent.
    static func makeImage(width: Int, height: Int, noisy: Bool = false, alpha: Bool = false) throws -> CGImage {
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 255, count: bytesPerRow * height)
        var generator = SystemRandomNumberGenerator()
        for y in 0..<height {
            for x in 0..<width {
                let i = y * bytesPerRow + x * 4
                if noisy {
                    pixels[i] = UInt8.random(in: 0...255, using: &generator)
                    pixels[i + 1] = UInt8.random(in: 0...255, using: &generator)
                    pixels[i + 2] = UInt8.random(in: 0...255, using: &generator)
                } else {
                    pixels[i] = UInt8(x * 255 / max(width - 1, 1))
                    pixels[i + 1] = UInt8(y * 255 / max(height - 1, 1))
                    pixels[i + 2] = 128
                }
                pixels[i + 3] = alpha && x < width / 2 ? 0 : 255
            }
        }
        let info = alpha ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
        let provider = try #require(CGDataProvider(data: Data(pixels) as CFData))
        return try #require(CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: info.rawValue), provider: provider,
            decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    }

    static func encode(_ image: CGImage, as type: UTType, quality: Double? = nil) throws -> Data {
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        var options: [CFString: Any] = [:]
        if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    static func isJPEG(_ data: Data) -> Bool { data.starts(with: [0xFF, 0xD8, 0xFF]) }
    static func isPNG(_ data: Data) -> Bool { data.starts(with: [0x89, 0x50, 0x4E, 0x47]) }

    /// The pixel size of encoded bytes.
    static func size(of data: Data) throws -> (width: Int, height: Int) {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let width = try #require((properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue)
        let height = try #require((properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue)
        return (width, height)
    }

    @Test("a big JPEG photo is shrunk to 1024 pixels on its long side and stays a JPEG under 2 MB")
    func bigJPEG() throws {
        let source = try Self.encode(try Self.makeImage(width: 3000, height: 2000), as: .jpeg, quality: 0.9)
        let picture = try CollectiblePicture.prepare(source)
        #expect(picture.mimeType == "image/jpeg")
        #expect(picture.filename == "picture.jpg")
        #expect(Self.isJPEG(picture.data))
        #expect(picture.data.count <= CollectiblePictureLimits.maxUploadBytes)
        #expect(picture.width == 1024)
        #expect(abs(picture.height - 683) <= 1)
        let size = try Self.size(of: picture.data)
        #expect(size.width == picture.width && size.height == picture.height)
    }

    @Test("a PNG without transparency becomes a JPEG; a tall one is limited on its height")
    func opaquePNG() throws {
        let source = try Self.encode(try Self.makeImage(width: 1500, height: 2400), as: .png)
        let picture = try CollectiblePicture.prepare(source)
        #expect(Self.isJPEG(picture.data))
        #expect(picture.height == 1024)
        #expect(abs(picture.width - 640) <= 1)
    }

    @Test("a small picture is not enlarged")
    func smallStaysSmall() throws {
        let source = try Self.encode(try Self.makeImage(width: 200, height: 100), as: .jpeg)
        let picture = try CollectiblePicture.prepare(source)
        #expect(picture.width == 200)
        #expect(picture.height == 100)
    }

    @Test("a picture with transparency stays a PNG with its transparency")
    func transparentPNG() throws {
        let source = try Self.encode(try Self.makeImage(width: 800, height: 600, alpha: true), as: .png)
        let picture = try CollectiblePicture.prepare(source)
        #expect(picture.mimeType == "image/png")
        #expect(picture.filename == "picture.png")
        #expect(Self.isPNG(picture.data))
        #expect(picture.data.count <= CollectiblePictureLimits.maxUploadBytes)
        let imageSource = try #require(CGImageSourceCreateWithData(picture.data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyHasAlpha] as? Bool == true)
    }

    @Test("a picture that does not compress is stepped down until it fits, and never goes over the limit")
    func noisyPhoto() throws {
        let source = try Self.encode(try Self.makeImage(width: 2000, height: 1500, noisy: true), as: .png)
        // A tight target forces more than one step.
        let picture = try CollectiblePicture.prepare(source, targetBytes: 450_000)
        #expect(picture.data.count <= 450_000)
        #expect(max(picture.width, picture.height) <= 1024)
        #expect(Self.isJPEG(picture.data))
    }

    @Test("a picture that cannot be made small enough is refused in words")
    func cannotShrink() throws {
        let source = try Self.encode(try Self.makeImage(width: 1200, height: 1200, noisy: true), as: .png)
        #expect(throws: CollectiblePictureError.cannotShrink) {
            try CollectiblePicture.prepare(source, targetBytes: 2_000)
        }
        #expect(!CollectiblePictureError.cannotShrink.message.isEmpty)
    }

    @Test("bytes that are not a picture, and nothing at all, are unreadable")
    func unreadable() {
        #expect(throws: CollectiblePictureError.unreadable) {
            try CollectiblePicture.prepare(Data("not a picture".utf8))
        }
        #expect(throws: CollectiblePictureError.unreadable) { try CollectiblePicture.prepare(Data()) }
        #expect(throws: CollectiblePictureError.unreadable) {
            // An SVG is text, not a picture the phone reads.
            try CollectiblePicture.prepare(Data("<svg xmlns='http://www.w3.org/2000/svg'/>".utf8))
        }
    }

    @Test("a HEIC photo becomes a JPEG, on a device that can write HEIC")
    func heic() throws {
        let image = try Self.makeImage(width: 3000, height: 2250)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.heic.identifier as CFString, 1, nil) else {
            // This machine has no HEIC encoder: nothing to test here.
            return
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return }
        let picture = try CollectiblePicture.prepare(data as Data)
        #expect(Self.isJPEG(picture.data))
        #expect(picture.width == 1024)
        #expect(picture.data.count <= CollectiblePictureLimits.maxUploadBytes)
    }

    @Test("the metadata of a photo is not carried over")
    func metadataDropped() throws {
        let image = try Self.makeImage(width: 400, height: 300)
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 59.9, kCGImagePropertyGPSLongitude: 10.7]
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyGPSDictionary: gps] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let picture = try CollectiblePicture.prepare(data as Data)
        let source = try #require(CGImageSourceCreateWithData(picture.data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyGPSDictionary] == nil)
    }

    @Test("the limits are the server's")
    func limits() {
        #expect(CollectiblePictureLimits.maxUploadBytes == 2 * 1024 * 1024)
        #expect(CollectiblePictureLimits.maxPicturesPerServer == 200)
        #expect(CollectiblePictureLimits.maxMegabytesPerServer == 25)
        #expect(CollectiblePictureLimits.maxSide <= 8192)
        #expect(CollectiblePictureLimits.maxSide * CollectiblePictureLimits.maxSide < 16_000_000)
    }
}
#endif

@Suite("Collectible picture errors")
struct CollectiblePictureErrorTests {
    @Test("every way a photo can fail has a sentence")
    func messages() {
        for error in [CollectiblePictureError.unreadable, .tooLargeToRead, .cannotShrink, .unavailable] {
            #expect(!error.message.isEmpty)
        }
    }
}
