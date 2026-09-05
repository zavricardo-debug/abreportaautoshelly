package com.example.shellydoor

import android.app.Application
import android.util.Log
import androidx.appcompat.app.AppCompatDelegate

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // A app é sempre clara (fundo branco), mesmo com o modo escuro do
        // sistema ligado. Sem isto, o tema seguia o telemóvel e os textos
        // cinzentos do ecrã principal ficavam ilegíveis sobre fundo preto.
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO)
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
