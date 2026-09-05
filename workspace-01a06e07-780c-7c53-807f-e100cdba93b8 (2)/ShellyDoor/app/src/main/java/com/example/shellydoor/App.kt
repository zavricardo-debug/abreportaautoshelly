package com.example.shellydoor

import android.app.Application
import android.util.Log

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        // Cria as moradas por defeito (Ladra, Alvalade, Argandona) apenas no 1.º arranque
        DoorStore(this).seedIfNeeded()
        // Se a automação estava ligada, re-arranca o serviço na abertura da app
        if (Prefs(this).autoEnabled) {
            Log.i("App", "A rearmar automação ao arrancar")
            DoorServiceStarter.ensureRunning(this)
        }
    }
}
