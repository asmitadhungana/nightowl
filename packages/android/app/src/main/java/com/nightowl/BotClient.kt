package com.nightowl

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * HTTP client for the NightOwl bot Worker. Wire-compatible with the macOS / Windows
 * desktop client in [packages/desktop/src/main/friendlock.ts].
 *
 * Preimage formats — must match the bot's [packages/bot/src/routes/*.ts] exactly:
 *   enroll              : "enroll|<userPubkeyHex>|<ts>"
 *   poll                : "poll|<pairingId>|<lastSeq>|<ts>"
 *   request_uninstall   : "request_uninstall|<pairingId>|<reqId>|<ts>"
 *
 * Where ts = epoch millis (must be within 60s of bot's wall clock).
 *
 * This is the tracer-bullet subset. Friend Focus + uninstall flow are sketched but
 * not yet wired into the UI.
 */
class BotClient(
    private val identity: Identity,
    private val baseUrl: String = DEFAULT_BASE_URL,
) {
    private val http = OkHttpClient.Builder()
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    suspend fun enroll(): EnrollResponse = withContext(Dispatchers.IO) {
        val ts = System.currentTimeMillis()
        val preimage = "enroll|${identity.publicKeyHex}|$ts"
        val body = EnrollBody(
            userPubkeyHex = identity.publicKeyHex,
            ts = ts,
            sig = identity.sign(preimage),
        )
        post("/desktop/enroll", json.encodeToString(body))
    }

    suspend fun poll(pairingId: String, lastSeq: Long): PollResponse = withContext(Dispatchers.IO) {
        val ts = System.currentTimeMillis()
        val preimage = "poll|$pairingId|$lastSeq|$ts"
        val body = PollBody(
            pairingId = pairingId,
            lastSeq = lastSeq,
            ts = ts,
            sig = identity.sign(preimage),
        )
        post("/desktop/poll", json.encodeToString(body))
    }

    suspend fun requestUninstall(pairingId: String, reqId: String): JsonElement = withContext(Dispatchers.IO) {
        val ts = System.currentTimeMillis()
        val preimage = "request_uninstall|$pairingId|$reqId|$ts"
        val body = UninstallBody(
            pairingId = pairingId,
            reqId = reqId,
            ts = ts,
            sig = identity.sign(preimage),
        )
        json.parseToJsonElement(postRaw("/desktop/request-uninstall", json.encodeToString(body)))
    }

    private inline fun <reified T> post(path: String, body: String): T {
        val raw = postRaw(path, body)
        return json.decodeFromString<T>(raw)
    }

    private fun postRaw(path: String, body: String): String {
        val req = Request.Builder()
            .url(baseUrl + path)
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            check(resp.isSuccessful) { "bot $path returned ${resp.code}: $text" }
            return text
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://nightowl-bot.asmee-dh-work.workers.dev"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}

@Serializable
private data class EnrollBody(val userPubkeyHex: String, val ts: Long, val sig: String)

@Serializable
data class EnrollResponse(val pairingId: String, val pairCode: String)

@Serializable
private data class PollBody(val pairingId: String, val lastSeq: Long, val ts: Long, val sig: String)

@Serializable
data class PollResponse(val messages: List<BotMessage> = emptyList())

@Serializable
data class BotMessage(val seq: Long, val kind: String, val payload: JsonElement, val sig: String)

@Serializable
private data class UninstallBody(val pairingId: String, val reqId: String, val ts: Long, val sig: String)
