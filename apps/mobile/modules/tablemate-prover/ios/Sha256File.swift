import ExpoModulesCore
import CryptoKit
import Foundation

/// The path handed over by the JS layer does not resolve to an existing file.
/// Its reason is fixed text: it never carries the path, which names the app's document directory, and never any part of the file.
final class FileMissingException: Exception {
  override var code: String {
    "ERR_FILE_MISSING"
  }

  override var reason: String {
    "File not found"
  }
}

/// The file exists but could not be read, so no digest can be produced.
final class HashFailedException: Exception {
  override var code: String {
    "ERR_HASH_FAILED"
  }

  override var reason: String {
    "File could not be read"
  }
}

/// Incremental SHA-256 over a file on disk, used to check a downloaded proving key against the hash in `artifacts.manifest.json`.
/// A proving key runs from hundreds of megabytes to gigabytes, so the file is never held in memory and never memory-mapped: the digest is fed one chunk at a time and peak memory stays at about one chunk; `hex` is synchronous and keeps no state between calls.
enum Sha256File {
  private static let chunkSize = 1 << 20

  static func hex(_ path: String) throws -> String {
    let url: URL? = path.hasPrefix("file://") ? URL(string: path) : URL(fileURLWithPath: path)

    guard let fileURL = url, fileURL.isFileURL else {
      throw FileMissingException()
    }

    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
      throw FileMissingException()
    }

    let handle: FileHandle
    do {
      handle = try FileHandle(forReadingFrom: fileURL)
    } catch {
      throw HashFailedException()
    }
    defer { try? handle.close() }

    var hasher = SHA256()
    while true {
      // Each chunk waits in an autorelease pool, so the Data a read returns is released before the next read, whatever the size of the file.
      let data: Data?
      do {
        data = try autoreleasepool { try handle.read(upToCount: Sha256File.chunkSize) }
      } catch {
        throw HashFailedException()
      }
      guard let chunk = data, !chunk.isEmpty else {
        break
      }
      hasher.update(data: chunk)
    }

    let digest = hasher.finalize()
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}
