package sahay.relay

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.io.File
import java.security.MessageDigest

/**
 * One carried report. [envelope] is exactly what we received (hops as received); we only ever mutate hops
 * on the copy we send. Opaque ciphertext: the relay cannot read the report.
 */
data class Record(
    val reportId: String,
    val envelope: JsonObject,
    val origin: Boolean,                       // created on this phone
    val sources: MutableSet<String> = mutableSetOf(),   // peer device_ids it came from (path back for receipts)
    var delivered: Boolean = false,            // server confirmed (receipt) - stop carrying
    var receipt: JsonObject? = null,
    var status: Msg.Status? = null,
    val receivedAt: Long,
    val receiptSentTo: MutableSet<String> = mutableSetOf(),
    val statusSentTo: MutableSet<String> = mutableSetOf(),
)

interface RelayStore {
    fun loadAll(): List<Record>
    fun save(r: Record)
    fun delete(reportId: String)
}

class InMemoryStore : RelayStore {
    private val map = LinkedHashMap<String, Record>()
    override fun loadAll() = map.values.toList()
    override fun save(r: Record) { map[r.reportId] = r }
    override fun delete(reportId: String) { map.remove(reportId) }
}

/** One JSON file per report, written atomically (temp file + rename) so a crash never leaves a torn record. */
class FileStore(private val dir: File) : RelayStore {
    init { dir.mkdirs() }

    /** SHA-256 of the id: distinct ids never share a file, and hostile ids cannot escape [dir]. */
    private fun file(id: String) = File(dir, sha256Hex(id) + ".json")

    override fun save(r: Record) {
        val tmp = File(dir, "${file(r.reportId).name}.tmp")
        tmp.writeText(toJson(r).toString(), Charsets.UTF_8)
        if (!tmp.renameTo(file(r.reportId))) {   // Windows can refuse to overwrite
            file(r.reportId).delete()
            tmp.renameTo(file(r.reportId))
        }
    }

    override fun delete(reportId: String) { file(reportId).delete() }

    override fun loadAll(): List<Record> =
        (dir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()).mapNotNull {
            try { fromJson(Json.parseToJsonElement(it.readText(Charsets.UTF_8)).jsonObject) } catch (e: Exception) { null }
        }.sortedBy { it.receivedAt }

    companion object {
        private fun sha256Hex(s: String) =
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

        fun toJson(r: Record): JsonObject = buildJsonObject {
            put("report_id", r.reportId); put("envelope", r.envelope); put("origin", r.origin)
            put("sources", JsonArray(r.sources.map { JsonPrimitive(it) }))
            put("delivered", r.delivered); put("received_at", r.receivedAt)
            put("receipt", r.receipt ?: JsonNull)
            r.status?.let { put("status", buildJsonObject { put("status", it.status); put("message", it.message); put("signature", it.signature); put("updated_at", it.updatedAt) }) }
            put("receipt_sent_to", JsonArray(r.receiptSentTo.map { JsonPrimitive(it) }))
            put("status_sent_to", JsonArray(r.statusSentTo.map { JsonPrimitive(it) }))
        }

        fun fromJson(o: JsonObject): Record {
            val id = o["report_id"]!!.jsonPrimitive.content
            fun set(k: String) = (o[k] as? JsonArray)?.map { it.jsonPrimitive.content }?.toMutableSet() ?: mutableSetOf()
            return Record(
                reportId = id, envelope = o["envelope"]!!.jsonObject, origin = o["origin"]!!.jsonPrimitive.boolean,
                sources = set("sources"), delivered = o["delivered"]!!.jsonPrimitive.boolean,
                receipt = o["receipt"] as? JsonObject,
                status = (o["status"] as? JsonObject)?.let {
                    Msg.Status(id, it["status"]!!.jsonPrimitive.content, it["message"]!!.jsonPrimitive.content,
                        (it["signature"] as? JsonPrimitive)?.content ?: "", (it["updated_at"] as? JsonPrimitive)?.content ?: "")
                },
                receivedAt = o["received_at"]!!.jsonPrimitive.long,
                receiptSentTo = set("receipt_sent_to"), statusSentTo = set("status_sent_to"),
            )
        }
    }
}
