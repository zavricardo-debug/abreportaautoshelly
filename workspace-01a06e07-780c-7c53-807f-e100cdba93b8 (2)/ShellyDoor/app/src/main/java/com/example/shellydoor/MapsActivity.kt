package com.example.shellydoor

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.location.LocationServices
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.OnMapReadyCallback
import com.google.android.gms.maps.SupportMapFragment
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CircleOptions
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.MarkerOptions

/**
 * Seletor do ponto da porta num mapa.
 *  - Centro inicial: na porta já guardada (se existir), senão na tua posição atual.
 *  - Toco ("long press") para colocares o marcador (o ponto vem lá de baixo).
 *  - Botão "Usar este ponto" grava as coordenadas e volta ao ecrã principal.
 *
 * O mapa precisa da tua Google Maps API key — está configurada no manifest (placeholder).
 */
class MapsActivity : AppCompatActivity(), OnMapReadyCallback {

    private lateinit var store: DoorStore
    private var door: Door? = null
    private var map: GoogleMap? = null
    private var selected: LatLng? = null
    private var centered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_map)
        store = DoorStore(this)

        val fm = supportFragmentManager.findFragmentById(R.id.map) as SupportMapFragment
        fm.getMapAsync(this)

        val doorId = intent.getStringExtra(EXTRA_DOOR_ID)
        door = doorId?.let { store.byId(it) }

        findViewById<android.widget.Button>(R.id.btnUseThisPoint).setOnClickListener {
            val p = selected
            val d = door
            if (p != null && d != null) {
                d.lat = p.latitude; d.lng = p.longitude
                store.update(d)
                setResult(RESULT_OK)
                Toast.makeText(this, "Ponto de ${d.name} guardado ✓", Toast.LENGTH_SHORT).show()
                finish()
            } else {
                Toast.makeText(this, "Toca no mapa para escolher o ponto da porta", Toast.LENGTH_SHORT).show()
            }
        }

        findViewById<android.widget.Button>(R.id.btnMyLocation).setOnClickListener { goToMyLocation() }

        if (door != null && door!!.hasPoint()) {
            selected = LatLng(door!!.lat, door!!.lng)
        } else {
            // Se a morada ainda não tem ponto, centrar na primeira que tenha (se houver)
            val last = store.all().firstOrNull { it.hasPoint() }
            if (last != null) selected = LatLng(last.lat, last.lng)
        }
    }

    override fun onMapReady(googleMap: GoogleMap) {
        map = googleMap

        googleMap.setOnMapLongClickListener { latLng ->
            selected = latLng
            drawPoint(googleMap, latLng)
            googleMap.animateCamera(CameraUpdateFactory.newLatLngZoom(latLng, 18f))
        }

        if (selected != null) {
            drawPoint(googleMap, selected!!)
            googleMap.moveCamera(CameraUpdateFactory.newLatLngZoom(selected!!, 18f))
            centered = true
        } else {
            goToMyLocation()
        }
    }

    /** Desenha o marcador + o círculo do raio (da morada) à volta do ponto escolhido. */
    private fun drawPoint(gm: GoogleMap, latLng: LatLng) {
        gm.clear()
        gm.addMarker(MarkerOptions().position(latLng)
            .title("Ponto da porta")
            .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_GREEN)))
        val radius = door?.radiusM ?: 35f
        gm.addCircle(
            CircleOptions()
                .center(latLng)
                .radius(radius.toDouble())
                .strokeColor(0xFF1565C0.toInt())
                .strokeWidth(2f)
                .fillColor(0x221565C0)
        )
    }

    @SuppressLint("MissingPermission")
    private fun goToMyLocation() {
        if (map == null) return
        LocationServices.getFusedLocationProviderClient(this)
            .lastLocation
            .addOnSuccessListener { loc ->
                if (loc != null) {
                    val ll = LatLng(loc.latitude, loc.longitude)
                    if (!centered) {
                        map!!.moveCamera(CameraUpdateFactory.newLatLngZoom(ll, 18f))
                        centered = true
                    }
                } else {
                    Log.w(TAG, "Sem posição para centrar o mapa")
                }
            }
    }

    companion object {
        private const val TAG = "MapsActivity"
        const val EXTRA_DOOR_ID = "door_id"
    }
}
