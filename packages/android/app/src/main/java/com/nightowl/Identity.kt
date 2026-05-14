package com.nightowl

import android.content.Context
import android.util.Base64
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import java.io.File
import java.security.SecureRandom

/**
 * Ed25519 identity for talking to the bot.
 *
 * Wire-compatible with the macOS / Windows desktop in [packages/shared/src/identity.ts]:
 * - Private key is the raw 32-byte Ed25519 seed.
 * - Public key is the raw 32-byte Ed25519 public component.
 * - [BOT_PUBKEY_HEX] is hardcoded; a compromised Worker cannot forge messages.
 *
 * Keypair persistence: stored in app-private files dir at [KEY_FILENAME] (private,
 * not accessible to other apps without root). On first boot we generate a fresh
 * keypair and write it; subsequent boots load the existing one.
 */
class Identity private constructor(
    val privateKey: ByteArray,
    val publicKey: ByteArray,
) {
    val publicKeyHex: String get() = publicKey.toHex()

    private val signer: Ed25519Sign = Ed25519Sign(privateKey)

    /** Sign [payload] (UTF-8 encoded) and return the base64-encoded 64-byte signature. */
    fun sign(payload: String): String {
        val sig = signer.sign(payload.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sig, Base64.NO_WRAP)
    }

    companion object {
        const val BOT_PUBKEY_HEX = "c67a4785231869d571763e2f9f0a9c8a0f8c7480ffbe70a56259a50e4b849431"
        private const val KEY_FILENAME = "identity.key"

        /** Load existing or generate fresh. Stable across app restarts. */
        fun loadOrCreate(ctx: Context): Identity {
            val file = File(ctx.filesDir, KEY_FILENAME)
            return if (file.exists()) load(file) else generateAndSave(file)
        }

        private fun load(file: File): Identity {
            val bytes = file.readBytes()
            require(bytes.size == 64) { "identity.key must be 64 bytes (32 priv + 32 pub), got ${bytes.size}" }
            return Identity(bytes.copyOfRange(0, 32), bytes.copyOfRange(32, 64))
        }

        private fun generateAndSave(file: File): Identity {
            // Tink's Ed25519Sign.KeyPair.newKeyPair() generates a 32-byte seed
            // via its own SecureRandom internally — we don't pass our own. The
            // returned keyPair.privateKey is the raw 32-byte seed; the public
            // key is the derived 32-byte Ed25519 public component.
            val keyPair = Ed25519Sign.KeyPair.newKeyPair()
            file.writeBytes(keyPair.privateKey + keyPair.publicKey)
            return Identity(keyPair.privateKey, keyPair.publicKey)
        }

        /**
         * Verify a base64-encoded signature from the bot. Returns true iff valid.
         *
         * The bot encodes with standard-alphabet base64 (`btoa` → `+/`), so we decode
         * with [Base64.NO_WRAP] only — NOT [Base64.URL_SAFE], which would expect `-_`.
         */
        fun verifyBotSignature(canonical: String, sigB64: String): Boolean {
            return try {
                val sig = Base64.decode(sigB64, Base64.NO_WRAP)
                if (sig.size != 64) return false
                Ed25519Verify(BOT_PUBKEY_HEX.hexToBytes()).verify(sig, canonical.toByteArray(Charsets.UTF_8))
                true
            } catch (_: GeneralSecurityException) {
                false
            } catch (_: IllegalArgumentException) {
                false
            }
        }
    }
}

internal fun ByteArray.toHex(): String =
    joinToString("") { "%02x".format(it) }

internal fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0) { "hex string must have even length" }
    return ByteArray(length / 2) { i ->
        ((Character.digit(this[i * 2], 16) shl 4) or Character.digit(this[i * 2 + 1], 16)).toByte()
    }
}

// Imported aliases — keeps the catch blocks above readable without polluting the top-level imports.
private typealias GeneralSecurityException = java.security.GeneralSecurityException
