package expo.modules.tablemateprover

import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest

// `cause` is null in both exceptions: Expo forwards the message and a chained cause across the bridge, and a FileNotFoundException's text carries the path, which must never reach JS logs.
internal class FileMissingException : CodedException("ERR_FILE_MISSING", "The file to hash does not exist.", null)
internal class HashFailedException : CodedException("ERR_HASH_FAILED", "The file could not be hashed.", null)

/**
 * Incremental SHA-256 over a file on disk, used to check a downloaded proving key against the `sha256` of the `zkey` entry in `artifacts.manifest.json`.
 * A proving key runs from hundreds of megabytes to gigabytes, so the file is never read whole and never memory-mapped: one fixed buffer is fed to the digest in turn.
 */
internal object Sha256File {
  private const val BUFFER_SIZE = 1 shl 20

  private const val HEX = "0123456789abcdef"

  fun hex(path: String): String {
    val resolved = if (path.startsWith("file://")) Uri.parse(path).path else path
    if (resolved == null) {
      throw FileMissingException()
    }

    val file = File(resolved)
    val readable = try {
      file.isFile
    } catch (cause: SecurityException) {
      throw HashFailedException()
    }
    if (!readable) {
      throw FileMissingException()
    }

    val digest = try {
      MessageDigest.getInstance("SHA-256")
    } catch (cause: Exception) {
      throw HashFailedException()
    }

    // The key can be gigabytes, so the buffer is fixed and the file is streamed, never held whole.
    val buffer = ByteArray(BUFFER_SIZE)
    try {
      FileInputStream(file).use { input ->
        while (true) {
          val read = input.read(buffer)
          if (read < 0) {
            break
          }
          digest.update(buffer, 0, read)
        }
      }
    } catch (cause: IOException) {
      throw HashFailedException()
    } catch (cause: SecurityException) {
      throw HashFailedException()
    }

    val bytes = digest.digest()
    // Nibbles are mapped directly: "%02x" per byte is slower, and BigInteger drops leading zeros.
    val chars = CharArray(64)
    for (index in bytes.indices) {
      val value = bytes[index].toInt() and 0xff
      chars[index * 2] = HEX[value ushr 4]
      chars[index * 2 + 1] = HEX[value and 0x0f]
    }
    return String(chars)
  }
}
