# PartyPulse

Live Google Photos album slideshow voor feesten. Gasten uploaden foto's via een
gedeelde album-link; PartyPulse speelt het album fullscreen af en toont **nieuwe
uploads meteen** als volgende foto — geen reload, geen wachten tot de lijst rond is.

## Hoe het werkt

- Leest een **publiek gedeeld** Google Photos-album uit zonder OAuth: de album-pagina
  bevat de volledige fotolijst in een ingebedde RPC-payload (`AF_initDataCallback`, key
  `ds:1`). Alleen de Python-standaardbibliotheek, geen dependencies.
- De browser toont foto na foto (crossfade). Bij een nieuwe upload onderbreekt de
  slideshow de huidige foto en toont de nieuwe direct, met een **NIEUW**-badge.
- Aan het einde van elke ronde wordt de lijst automatisch ververst.

## Draaien

```bash
python3 slideshow.py
```

Open dan `http://<host>:11111/`. Klik of druk een toets voor volledig scherm;
`i` togglet de album-naam/statusregel.

## Instellingen

Via de web-UI op `/config`, of rechtstreeks in `config.json`:

| sleutel | betekenis | default |
|---|---|---|
| `album_url` | share-link van het album (`https://photos.app.goo.gl/…`) | — |
| `port` | poort | `11111` |
| `slide_seconds` | seconden per foto | `6` |
| `order` | `oldest` / `newest` / `none` | `oldest` |
| `image_width` | opgevraagde beeldbreedte (px) | `1600` |
| `thumb_width` | breedte van het voorlaad-thumbnail | `480` |
| `cache_seconds` | server-cache op de albumlijst | `5` |
| `poll_seconds` | hoe vaak op nieuwe foto's gecontroleerd wordt | `5` |
| `priority_new` | nieuwe foto's direct als volgende tonen (huidige onderbreken) | `true` |
| `min_show_seconds` | minimumtijd per foto vóór een onderbreking | `1.5` |
| `show_overlay` | album-naam, status en ronde-duur tonen | `true` |
| `title_text` | titelscherm vóór de show (leeg = geen titelscherm; Enter of `\n` = tussenregel) | `""` |
| `title_seconds` | duur titelscherm (s) | `8` |
| `ken_burns` | langzame zoom/pan op elke foto | `false` |
| `end_loop_enabled` | eindlus aan het einde van elke volledige ronde | `false` |
| `end_film_enabled` | snelle montage van foto's uit sessie (bin. eindlus) | `false` |
| `end_film_seconds` | seconden per foto in de eindfilm | `1.0` |
| `top_uploaders_enabled` | Top uploaders-scherm (met namen + avatars) | `true` |
| `top_uploaders_count` | aantal namen in de top | `10` |
| `qr_upload_enabled` | QR-scherm om uploaden te bevorderen (gebruikt `/qr.png`) | `false` |

De statusregel toont ook de duur van een volledige ronde (`slide_seconds × aantal foto's`).

**Eindlus** (alleen als `end_loop_enabled` aan staat): na elke volledige ronde —
eindfilm (indien aan) → Top uploaders → QR (indien aan) — en daarna herstart de ronde.

De QR-afbeelding staat op `static/qr.png` en verwijst naar de ingestelde album-link; het
scherm valt automatisch terug op een online QR-API als het bestand ontbreekt.

## systemd

```ini
[Unit]
Description=PartyPulse — Google Photos album slideshow
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/opencode/PartyPulse
ExecStart=/usr/bin/python3 /opt/opencode/PartyPulse/slideshow.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Kanttekeningen

- Het album moet **publiek gedeeld** blijven; de lijst wordt via de publieke pagina
  uitgelezen (geen OAuth).
- Video's verschijnen enkel als stilstaand beeld.

## Authenticatie (optioneel)

De server is standaard open. Zodra er een `auth.json` naast de config staat, vraagt hij
HTTP **Basic Auth** op alles (pagina, `/config` en de API). Ontbrekend of leeg bestand =
geen auth.

`auth.json` (zet op `chmod 600`, niet committen):

```json
{
  "users": {
    "admin": { "salt": "<hex>", "hash": "<sha256(salt+ww) hex>" }
  }
}
```

Gebruikers toevoegen/wijzigen:

```python
import json, os
from slideshow import make_user_record
path = "auth.json"
data = {"users": {}}
if os.path.exists(path):
    data = json.load(open(path))
data["users"]["naam"] = make_user_record("wachtwoord")
json.dump(data, open(path, "w"), indent=2)
os.chmod(path, 0o600)
```

Paden zijn te overschrijven met de omgevingsvariabelen `PARTYPULSE_CONFIG`,
`PARTYPULSE_AUTH` en `PARTYPULSE_STATIC`, zodat één codebase meerdere poorten/albums kan
bedienen (elk met eigen config + gebruikers).

> Let op: Basic Auth versleutelt niets — het wachtwoord gaat base64-leesbaar over HTTP.
> Combineer met HTTPS (TLS-terminatie of een reverse proxy) op een niet-vertrouwd netwerk.

