package com.nightowl

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Mirror of `canonicalJson` in `packages/bot/src/crypto.ts` and
 * `packages/desktop/src/main/friendlock.ts`. **MUST** produce byte-identical
 * output for the same logical value or bot signatures won't verify.
 *
 * Rules:
 *   - object keys sorted lexicographically at every depth
 *   - array order preserved
 *   - primitive serialization matches JSON.stringify:
 *       strings: JSON-escaped, wrapped in `"`
 *       numbers/booleans/null: raw keyword/digits
 *
 * Used in [botMessagePreimage] to reconstruct the bytes the bot signed.
 */
fun canonicalJson(value: JsonElement): String = when (value) {
    is JsonNull -> "null"
    is JsonPrimitive -> if (value.isString) jsonEscape(value.content) else value.content
    is JsonArray -> value.joinToString(prefix = "[", postfix = "]", separator = ",") { canonicalJson(it) }
    is JsonObject -> value.entries
        .sortedBy { it.key }
        .joinToString(prefix = "{", postfix = "}", separator = ",") { (k, v) ->
            jsonEscape(k) + ":" + canonicalJson(v)
        }
}

/**
 * Build the canonical pre-image the bot signs over for an outbound inbox message.
 * Format: `v2|<pairingId>|<seq>|<kind>|<canonicalJson(payload)>` — see
 * `botMessagePreimage` in `packages/bot/src/crypto.ts`.
 */
fun botMessagePreimage(pairingId: String, seq: Long, kind: String, payload: JsonElement): String =
    "v2|$pairingId|$seq|$kind|${canonicalJson(payload)}"

/**
 * JS `JSON.stringify` string-escape rules. Escapes `"`, `\`, and ASCII control chars
 * (0x00–0x1F). Non-ASCII passes through — `JSON.stringify` only escapes those when
 * the `replacer` argument is used, which the bot does not.
 *
 * Kotlin has no `\f` char literal, so form-feed is matched by ``.
 */
private fun jsonEscape(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (c in s) {
        when (c) {
            '\\'     -> sb.append("\\\\")
            '"'      -> sb.append("\\\"")
            '\b'     -> sb.append("\\b")
            '' -> sb.append("\\f")
            '\n'     -> sb.append("\\n")
            '\r'     -> sb.append("\\r")
            '\t'     -> sb.append("\\t")
            else -> if (c.code < 0x20) {
                sb.append("\\u").append("%04x".format(c.code))
            } else {
                sb.append(c)
            }
        }
    }
    sb.append('"')
    return sb.toString()
}
