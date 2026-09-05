package com.example.shellydoor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Notificações com o botão manual "Abrir porta", que leva consigo o id da morada
 * para, no fim, abrir o Shelly certo.
 */
object Notifier {

    const val CHANNEL_STATUS = "door_status"
    const val CHANNEL_ALERT = "door_alert"
    const val ACTION_OPEN_MANUAL = "com.example.shellydoor.OPEN_MANUAL"
    const val EXTRA_DOOR_ID = "door_id"
    const val NOTIF_ID_ALERT = 1001

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_STATUS, "Estado da porta", NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ALERT, "Abertura de porta", NotificationManager.IMPORTANCE_HIGH))
        }
    }

    fun statusNotification(context: Context, text: String): Notification {
        val builder = Notification.Builder(context, CHANNEL_STATUS)
            .setContentTitle("ShellyDoor")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
        return builder.build()
    }

    /** Id de notificação próprio de cada morada (não se sobrepõem entre moradas). */
    private fun idFor(door: Door, offset: Int) =
        NOTIF_ID_ALERT + offset + (Math.abs(door.id.hashCode()) % 100) * 10

    fun showOpenNotification(context: Context, door: Door, text: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val builder = Notification.Builder(context, CHANNEL_ALERT)
            .setContentTitle("🚪 ${door.name}")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setAutoCancel(true)
        addManualAction(context, builder, door.id)
        nm.notify(idFor(door, 0), builder.build())
    }

    fun updateOpenNotification(context: Context, door: Door, text: String) {
        showOpenNotification(context, door, text)
    }

    fun showManualNotification(context: Context, door: Door, title: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val builder = Notification.Builder(context, CHANNEL_ALERT)
            .setContentTitle(title)
            .setContentText("Se estás mesmo a chegar, abre pelo botão abaixo.")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setAutoCancel(false)
        addManualAction(context, builder, door.id)
        nm.notify(idFor(door, 1), builder.build())
    }

    private fun addManualAction(context: Context, builder: Notification.Builder, doorId: String) {
        // Request code ÚNICO por morada: com o valor fixo "1" que estava aqui, o
        // PendingIntent de uma morada reutilizava os extras de outra e o botão
        // manual abria a porta errada (ou nenhuma).
        val pi = PendingIntent.getBroadcast(
            context,
            doorId.hashCode(),
            Intent(context, NotificationActionReceiver::class.java)
                .setAction(ACTION_OPEN_MANUAL)
                .setPackage(context.packageName)
                .putExtra(EXTRA_DOOR_ID, doorId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        builder.addAction(android.R.drawable.ic_menu_manage, "Abrir porta", pi)
    }
}

/** Recetor para o botão manual "Abrir porta" da notificação. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Notifier.ACTION_OPEN_MANUAL) {
            val doorId = intent.getStringExtra(Notifier.EXTRA_DOOR_ID)
            val door = doorId?.let { DoorStore(context).byId(it) }
            if (door == null) {
                Log.e(TAG, "Botão manual sem morada válida (id=$doorId)")
                return
            }
            Log.i(TAG, "Abertura manual pedida: ${door.name}")
            val app = context.applicationContext
            val prefs = Prefs(app)
            val store = DoorStore(app)
            // goAsync(): sem isto o processo do recetor podia ser morto antes de a
            // chamada HTTP ao Shelly terminar — o botão parecia não fazer nada.
            val pending = goAsync()
            Notifier.showOpenNotification(app, door, "A abrir manualmente…")
            ShellyController(prefs).openDoor(door) { ok, msg ->
                try {
                    prefs.lastResult = "${door.name}: $msg"
                    if (ok) {
                        // Abriste à mão: desarma, para não reabrir sozinha logo a seguir.
                        store.byId(door.id)?.let { d ->
                            d.armed = false
                            d.lastOpenAt = System.currentTimeMillis()
                            d.lastReason = "Aberta à mão ✓"
                            store.update(d)
                        }
                    }
                    Notifier.updateOpenNotification(app, door, if (ok) "Porta aberta ✓" else "Erro: $msg")
                } finally {
                    pending.finish()
                }
            }
        }
    }
    private companion object { const val TAG = "NotifActionReceiver" }
}
