/*
 * WatchieTalkie2 – Walkie-Talkie mit Textnachrichten für die Pebble (Weiterführung des früheren Watchie-Talkie).
 * Die Uhr zeigt nur an und nimmt Sprache/Schnellantworten entgegen; alles Netzwerk macht PebbleKit JS (src/pkjs).
 */
#include <pebble.h>

/* Befehle pkjs → Uhr */
enum { C_LIST_ITEM = 2, C_MSG_ITEM = 5, C_NEW_MSG = 7, C_QR_ITEM = 8, C_STATUS = 9, C_SENT = 10, C_PUSH = 11, C_LOOK = 12 };
/* Befehle Uhr → pkjs */
enum { C_READY = 20, C_OPEN = 21, C_SEND = 22, C_CLOSE = 23, C_ACCEPT = 24, C_DECLINE = 25, C_SEND_VOICE = 26, C_TEST = 27, C_BEEP = 28, C_DELETE = 29, C_PAUSE = 30 };
/* Art eines Listeneintrags */
enum { K_CHAT = 0, K_CONTACT_INVITE = 1, K_GROUP_INVITE = 2 };
/* Auswahlmenü – mode 0: „Emoji …“, „Letzte Nachricht löschen“, „Push pausieren“, darunter Schnellantworten · 1: Einladung annehmen/ablehnen
   2: Emoji wählen · 3: Löschen bestätigen · 4: Liste (Push pausieren, Piep an/aus) */
enum { P_REPLY = 0, P_INVITE = 1, P_EMOJI = 2, P_DELETE = 3, P_LIST = 4 };

#if defined(PBL_PLATFORM_APLITE)
#define MAX_MSGS 10
#define MAX_CHATS 12
#else
#define MAX_MSGS 30
#define MAX_CHATS 20
#endif
#define MAX_QR 10
#define TEXT_BYTES 512

/* Schriftgröße im Chat (Einstellungsseite): 0 = klein (bisherige Schrift), 1/2 = größer und fett */
#if PBL_DISPLAY_WIDTH >= 200
static const char *FONT_BODY[] = { FONT_KEY_GOTHIC_24, FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_28_BOLD };
static const char *FONT_NAME[] = { FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_24_BOLD };
static const uint8_t NAME_H[] = { 20, 20, 26 };
#define FONT_HEAD FONT_KEY_GOTHIC_18_BOLD
#else
static const char *FONT_BODY[] = { FONT_KEY_GOTHIC_18, FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_28_BOLD };
static const char *FONT_NAME[] = { FONT_KEY_GOTHIC_14_BOLD, FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_18_BOLD };
static const uint8_t NAME_H[] = { 16, 20, 20 };
#define FONT_HEAD FONT_KEY_GOTHIC_14_BOLD
#endif
/* Menüs: Größe 0 = Systemzelle (menu_cell_basic_draw), 1/2 = eigene Zelle mit größerer Schrift (Titel · Untertitel) */
static const char *FONT_MTITLE[] = { NULL, FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_GOTHIC_28_BOLD };
#if PBL_DISPLAY_WIDTH >= 200
static const char *FONT_MSUB[] = { NULL, FONT_KEY_GOTHIC_24, FONT_KEY_GOTHIC_24_BOLD };
static const uint8_t MSUB_H[] = { 0, 26, 26 };
#else
static const char *FONT_MSUB[] = { NULL, FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_24_BOLD };
static const uint8_t MSUB_H[] = { 0, 20, 26 };
#endif
#define MTITLE_H 30
#define PAD 4
#define ACCENT PBL_IF_COLOR_ELSE(GColorSunsetOrange, GColorBlack)
#define ROUND_INSET PBL_IF_ROUND_ELSE(22, 0)
#define TOP (PBL_IF_ROUND_ELSE(36, 2) + s_name_h + 6)

/* Aussehen (Einstellungsseite, auf der Uhr gespeichert): Schriftgröße, Hinter-/Vordergrund (GColor8), Licht an */
#define PERSIST_LOOK 1
typedef struct { uint8_t font, bg, fg, light; } Look;
static Look s_look = { 0, 0xFF, 0xC0, 0 };    /* Standard: schwarze Schrift auf Weiß */
static GColor col(uint8_t argb) { return (GColor) { .argb = argb }; }
#define BG col(s_look.bg)
#define FG col(s_look.fg)
#if defined(PBL_COLOR)
/* Eigene Blasen: Mischfarbe 2/3 Hintergrund + 1/3 Schrift (je 2-Bit-Kanal) – hebt sich ab, Schrift bleibt lesbar */
static GColor soft(void) {
  uint8_t c = 0xC0;
  for (int sh = 0; sh < 6; sh += 2) c |= (((((s_look.bg >> sh) & 3) * 2 + ((s_look.fg >> sh) & 3) + 1) / 3) & 3) << sh;
  return col(c);
}
#endif

typedef struct { char id[20]; char title[26]; char preview[44]; uint8_t unread; uint8_t kind; } Chat;
typedef struct { char *text; char from[17]; bool mine; int16_t h; uint8_t emo[3], emo_n; } Msg;   /* emo: reine Emoji-Nachricht */

static Chat s_chats[MAX_CHATS];
static int s_chat_count;
/* Texte (nur Englisch) */
enum { T_LOADING, T_EMPTY_CHAT, T_EMOJI, T_ACCEPT, T_DECLINE, T_CONTACT_REQ, T_GROUP_INV, T_NO_VOICE, T_NEW_FROM, T_SEND_FAILED,
  T_DELETE_LAST, T_DELETE_YES, T_CANCEL, T_PAUSE, T_RESUME, T_BEEP_ON, T_BEEP_OFF, T_CONNECTING, T_NO_PHONE, T_NO_ANSWER, T_PHONE_LOST };
static const char *T_EN[] = { "Loading …", "No messages yet.\nSELECT: speak\nhold SELECT: emoji, quick reply", "Emoji …",
  "Accept", "Decline", "Contact request", "Group invitation", "Voice not available", "New from %s", "Sending failed",
  "Delete my last message", "Yes, delete it", "Cancel", "Pause push", "Resume push", "Beep on", "Beep off",
  "Connecting to phone …", "Phone not connected.\nOpen the Pebble app on your phone – loading continues automatically.",
  "No answer from phone.\nRetrying …", "Phone disconnected" };
#define TR(i) (T_EN[i])
static char s_status[160] = "…";

static Msg s_msgs[MAX_MSGS];
static int s_msg_count;
static char s_open_chat[20];
static char s_open_title[26];
static bool s_chat_loading;
static bool s_chat_failed;   /* Laden fehlgeschlagen: statt „Loading …“ steht s_status im Chat */

static char *s_qr[MAX_QR];
static int s_qr_count;
static bool s_vibe = true;
static bool s_beep = true;
/* Handy-Benachrichtigung (ntfy/Telegram/Pushover): eingerichtet? pausiert bis? Pausendauer in Minuten */
static bool s_push_avail;
static time_t s_pause_until;
static int s_pause_min = 15;
static bool paused(void) { return s_pause_until > time(NULL); }

/* Funk-Piep („Roger“) bei neuer Nachricht – nur Uhren mit Lautsprecher (Time 2, Pebble 2 Duo, Round 2).
   Ältere Modelle laufen mit Firmware ohne Lautsprecher-Funktionen, dort wird nichts aufgerufen.
   Nie im Ruhemodus der Uhr; in der Liste schaltet langes SELECT den Piep an/aus (wie auf der Einstellungsseite). */
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_FLINT) || defined(PBL_PLATFORM_GABBRO)
#define HAS_SPEAKER 1
#endif
static void roger_beep(void) {
#if defined(HAS_SPEAKER)
  static const SpeakerNote notes[] = {
    { .midi_note = 84, .waveform = SpeakerWaveformSquare, .duration_ms = 60, .velocity = 0 },
    { .midi_note = 0, .waveform = SpeakerWaveformSquare, .duration_ms = 25, .velocity = 0 },
    { .midi_note = 91, .waveform = SpeakerWaveformSquare, .duration_ms = 90, .velocity = 0 },
  };
  if (s_beep && !quiet_time_is_active()) speaker_play_notes(notes, ARRAY_LENGTH(notes), 35);
#endif
}

static Window *s_main_win, *s_chat_win, *s_pick_win;
static MenuLayer *s_menu, *s_pick_menu;
static ScrollLayer *s_scroll;
static Layer *s_content;
static TextLayer *s_banner;
static AppTimer *s_banner_timer;
static GFont s_font_body, s_font_head, s_font_name, s_font_mtitle, s_font_msub;
static int s_name_h;   /* Zeilenhöhe der Absender-/Titelschrift */
#if defined(PBL_MICROPHONE)
static DictationSession *s_dict;
#endif

/* ------------------------------------------------------------ Senden -- */
typedef struct { uint8_t cmd; char chat[20]; char text[TEXT_BYTES]; } Out;
static Out s_out[4];
static int s_out_len;
static AppTimer *s_out_timer;
static bool s_out_busy;

static void out_pump(void *ctx);
static void out_schedule(uint32_t ms) {
  if (!s_out_timer) s_out_timer = app_timer_register(ms, out_pump, NULL);
}
static void out_pump(void *ctx) {
  s_out_timer = NULL;
  if (!s_out_len || s_out_busy) return;
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) { out_schedule(250); return; }
  Out *o = &s_out[0];
  dict_write_uint8(it, MESSAGE_KEY_CMD, o->cmd);
  if (o->chat[0]) dict_write_cstring(it, MESSAGE_KEY_CHAT, o->chat);
  if (o->text[0]) dict_write_cstring(it, MESSAGE_KEY_TEXT, o->text);
  if (app_message_outbox_send() == APP_MSG_OK) s_out_busy = true;
  else out_schedule(250);
}
static void send_cmd(uint8_t cmd, const char *chat, const char *text) {
  if (s_out_len == (int)ARRAY_LENGTH(s_out)) { memmove(&s_out[0], &s_out[1], sizeof(Out) * (s_out_len - 1)); s_out_len--; }
  Out *o = &s_out[s_out_len++];
  o->cmd = cmd;
  strncpy(o->chat, chat ? chat : "", sizeof(o->chat) - 1); o->chat[sizeof(o->chat) - 1] = 0;
  strncpy(o->text, text ? text : "", sizeof(o->text) - 1); o->text[sizeof(o->text) - 1] = 0;
  out_schedule(10);
}
static void out_sent(DictionaryIterator *it, void *ctx) {
  s_out_busy = false;
  if (s_out_len) { memmove(&s_out[0], &s_out[1], sizeof(Out) * (s_out_len - 1)); s_out_len--; }
  out_schedule(10);
}
static void out_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  s_out_busy = false;
  out_schedule(500);
}

/* ------------------------------------------------------------ Banner -- */
static void banner_hide(void *ctx) { s_banner_timer = NULL; if (s_banner) layer_set_hidden(text_layer_get_layer(s_banner), true); }
static void banner_show(const char *text) {
  if (!s_banner) return;
  static char buf[64];
  strncpy(buf, text, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
  text_layer_set_text(s_banner, buf);
  layer_set_hidden(text_layer_get_layer(s_banner), false);
  if (s_banner_timer) app_timer_cancel(s_banner_timer);
  s_banner_timer = app_timer_register(3000, banner_hide, NULL);
}

/* ----------------------------------------------------------- Emoji -- */
/* Die Uhr-Schriften haben keine Emojis → eigene Bilder (tools/emoji.py, Noto Color Emoji). Gesendet wird das echte Emoji;
   Nachrichten, die nur aus 1–3 dieser Emojis bestehen, zeigt der Chat als Bilder (pkjs schickt sie dann unverändert). */
static const char *EMOJI[][2] = {
  { "\xF0\x9F\x91\x8D", "Thumbs up" }, { "\xF0\x9F\x98\x8A", "Smile" }, { "\xF0\x9F\x98\x82", "Laughing" },
  { "\xE2\x9D\xA4\xEF\xB8\x8F", "Heart" }, { "\xF0\x9F\x98\x89", "Wink" }, { "\xF0\x9F\x98\x80", "Grin" },
  { "\xF0\x9F\x98\x98", "Kiss" }, { "\xF0\x9F\x98\xAE", "Surprised" }, { "\xF0\x9F\x98\xA2", "Crying" },
  { "\xF0\x9F\x98\x9E", "Sad" }, { "\xF0\x9F\x98\xA1", "Angry" }, { "\xF0\x9F\xA4\x94", "Thinking" },
  { "\xF0\x9F\x91\x8B", "Wave" }, { "\xF0\x9F\x8E\x89", "Party" }, { "\xF0\x9F\x99\x8F", "Thanks" },
  { "\xF0\x9F\x91\x8C", "OK" }, { "\xF0\x9F\x91\x8E", "Thumbs down" },
};
#define EMOJI_N ((int)ARRAY_LENGTH(EMOJI))
static const uint32_t EMOJI_RES[] = { RESOURCE_ID_EMOJI_00, RESOURCE_ID_EMOJI_01, RESOURCE_ID_EMOJI_02, RESOURCE_ID_EMOJI_03,
  RESOURCE_ID_EMOJI_04, RESOURCE_ID_EMOJI_05, RESOURCE_ID_EMOJI_06, RESOURCE_ID_EMOJI_07, RESOURCE_ID_EMOJI_08, RESOURCE_ID_EMOJI_09,
  RESOURCE_ID_EMOJI_10, RESOURCE_ID_EMOJI_11, RESOURCE_ID_EMOJI_12, RESOURCE_ID_EMOJI_13, RESOURCE_ID_EMOJI_14, RESOURCE_ID_EMOJI_15,
  RESOURCE_ID_EMOJI_16 };
#define EMO PBL_IF_COLOR_ELSE((PBL_DISPLAY_WIDTH >= 200 ? 36 : 28), 28)
static GBitmap *s_emo_bmp[ARRAY_LENGTH(EMOJI)];   /* bei Bedarf geladen, freigegeben wenn Chat und Menü zu sind */
static void emoji_free(void) {
  for (int i = 0; i < EMOJI_N; i++) if (s_emo_bmp[i]) { gbitmap_destroy(s_emo_bmp[i]); s_emo_bmp[i] = NULL; }
}
/* Bild an p; S/W: Bild hat weißen Grund – auf schwarzem Grund als weiße Kachel */
static void emoji_draw(GContext *ctx, int i, GPoint p, GColor under) {
  if (!s_emo_bmp[i]) s_emo_bmp[i] = gbitmap_create_with_resource(EMOJI_RES[i]);
  if (!s_emo_bmp[i]) return;
  GRect r = GRect(p.x, p.y, EMO, EMO);
#if defined(PBL_COLOR)
  graphics_context_set_compositing_mode(ctx, GCompOpSet);
#else
  if (gcolor_equal(under, GColorBlack)) { graphics_context_set_fill_color(ctx, GColorWhite); graphics_fill_rect(ctx, grect_inset(r, GEdgeInsets(-2)), 5, GCornersAll); }
  graphics_context_set_compositing_mode(ctx, GCompOpAssign);
#endif
  graphics_draw_bitmap_in_rect(ctx, s_emo_bmp[i], r);
  graphics_context_set_compositing_mode(ctx, GCompOpAssign);
}
/* Text nur aus 1–3 Tabellen-Emojis (Leerzeichen/FE0F egal)? → Indizes nach out, Anzahl; sonst 0 */
static int emoji_parse(const char *t, uint8_t *out) {
  int n = 0;
  while (*t) {
    if (*t == ' ') { t++; continue; }
    if (!strncmp(t, "\xEF\xB8\x8F", 3)) { t += 3; continue; }
    int k = -1;
    size_t l = 0;
    for (int i = 0; i < EMOJI_N && k < 0; i++) {
      l = strlen(EMOJI[i][0]);
      if (l > 4 && !strcmp(EMOJI[i][0] + l - 3, "\xEF\xB8\x8F")) l -= 3;   /* Herz: ohne Variantenzeichen vergleichen */
      if (!strncmp(t, EMOJI[i][0], l)) k = i;
    }
    if (k < 0 || n == 3) return 0;
    out[n++] = k;
    t += l;
  }
  return n;
}

/* ------------------------------------------------------------- Chat -- */
static int text_width(void) {
  return PBL_DISPLAY_WIDTH - 2 * PAD - 2 * ROUND_INSET - 24;
}
static void measure(Msg *m) {
  m->emo_n = m->text ? emoji_parse(m->text, m->emo) : 0;
  if (m->emo_n) { m->h = EMO + 4 + (m->mine ? 0 : s_name_h) + 2 * PAD + 6; return; }
  GSize s = graphics_text_layout_get_content_size(m->text ? m->text : "", s_font_body, GRect(0, 0, text_width(), 2000),
                                                  GTextOverflowModeWordWrap, GTextAlignmentLeft);
  m->h = s.h + (m->mine ? 0 : s_name_h) + 2 * PAD + 6;
}
static const char *empty_text(void) { return s_chat_failed ? s_status : s_chat_loading ? TR(T_LOADING) : TR(T_EMPTY_CHAT); }
static int content_height(void) {
  int h = TOP;
  if (!s_msg_count) return h + 20 + graphics_text_layout_get_content_size(empty_text(), s_font_body,
    GRect(0, 0, PBL_DISPLAY_WIDTH - 2 * (PAD + ROUND_INSET), 2000), GTextOverflowModeWordWrap, GTextAlignmentCenter).h;
  for (int i = 0; i < s_msg_count; i++) h += s_msgs[i].h;
  return h + PBL_IF_ROUND_ELSE(40, 10);
}
static void content_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int x0 = PAD + ROUND_INSET, w = b.size.w - 2 * x0;
  int y = TOP;
  graphics_context_set_text_color(ctx, FG);
  graphics_draw_text(ctx, s_open_title, s_font_name, GRect(x0, y - s_name_h - 6, w, s_name_h + 8),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  if (!s_msg_count) {
    graphics_draw_text(ctx, empty_text(), s_font_body, GRect(x0, y, w, 200), GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }
  for (int i = 0; i < s_msg_count; i++) {
    Msg *m = &s_msgs[i];
    int bw = w - 12, bx = m->mine ? x0 + 12 : x0;
    GRect bubble = GRect(bx, y + 2, bw, m->h - 6);
    /* Eigene Nachricht: gefüllte Blase (Farbe: Mischfarbe, S/W: Schriftfarbe mit Hintergrund als Text), fremde: Rahmen */
    graphics_context_set_stroke_color(ctx, FG);
    if (m->mine) { graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(soft(), FG)); graphics_fill_rect(ctx, bubble, 6, GCornersAll); }
    else graphics_draw_round_rect(ctx, bubble, 6);
    graphics_context_set_text_color(ctx, m->mine ? PBL_IF_COLOR_ELSE(FG, BG) : FG);
    int ty = y + 2 + PAD - 3;
    if (!m->mine) {
      graphics_draw_text(ctx, m->from, s_font_name, GRect(bx + 6, ty, bw - 12, s_name_h + 6), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      ty += s_name_h;
    }
    if (m->emo_n) {                               /* reine Emoji-Nachricht: Bilder, eigene rechtsbündig */
      int ex = m->mine ? bx + bw - 6 - m->emo_n * (EMO + 2) : bx + 6;
      for (int k = 0; k < m->emo_n; k++)
        emoji_draw(ctx, m->emo[k], GPoint(ex + k * (EMO + 2), ty + 4), m->mine ? PBL_IF_COLOR_ELSE(soft(), FG) : BG);
    } else graphics_draw_text(ctx, m->text ? m->text : "", s_font_body, GRect(bx + 6, ty, bw - 12, 2000), GTextOverflowModeWordWrap,
                       m->mine ? GTextAlignmentRight : GTextAlignmentLeft, NULL);
    graphics_context_set_text_color(ctx, FG);
    y += m->h;
  }
}
static void chat_relayout(bool to_bottom) {
  if (!s_chat_win || !s_content) return;
  GRect b = layer_get_bounds(window_get_root_layer(s_chat_win));
  int h = content_height();
  layer_set_frame(s_content, GRect(0, 0, b.size.w, h));
  scroll_layer_set_content_size(s_scroll, GSize(b.size.w, h));
  if (to_bottom) scroll_layer_set_content_offset(s_scroll, GPoint(0, h > b.size.h ? b.size.h - h : 0), false);
  layer_mark_dirty(s_content);
}
static void msgs_clear(void) {
  for (int i = 0; i < s_msg_count; i++) { free(s_msgs[i].text); s_msgs[i].text = NULL; }
  s_msg_count = 0;
}
static void msg_set(Msg *m, const char *from, const char *text, bool mine) {
  free(m->text);
  size_t n = strlen(text) + 1;
  m->text = malloc(n);
  if (m->text) memcpy(m->text, text, n);
  strncpy(m->from, from, sizeof(m->from) - 1); m->from[sizeof(m->from) - 1] = 0;
  m->mine = mine;
  measure(m);
}
static void msg_append(const char *from, const char *text, bool mine) {
  if (s_msg_count == MAX_MSGS) {
    free(s_msgs[0].text);
    memmove(&s_msgs[0], &s_msgs[1], sizeof(Msg) * (MAX_MSGS - 1));
    s_msgs[MAX_MSGS - 1].text = NULL;
    s_msg_count--;
  }
  msg_set(&s_msgs[s_msg_count++], from, text, mine);
}

static void pick_open(int mode, bool focus_qr);
static void start_talk(void) {
#if defined(PBL_MICROPHONE)
  if (s_dict && dictation_session_start(s_dict) == DictationSessionStatusSuccess) return;
#endif
  pick_open(P_REPLY, true);
}
#if defined(PBL_MICROPHONE)
static void dict_done(DictationSession *session, DictationSessionStatus status, char *text, void *ctx) {
  if (status == DictationSessionStatusSuccess && text && text[0]) {
    msg_append("", text, true);
    chat_relayout(true);
    send_cmd(C_SEND_VOICE, s_open_chat, text);
  } else if (status != DictationSessionStatusFailureTranscriptionRejected) {
    banner_show(TR(T_NO_VOICE));
    pick_open(P_REPLY, true);
  }
}
#endif
static void chat_select(ClickRecognizerRef r, void *ctx) { start_talk(); }
static void chat_long_select(ClickRecognizerRef r, void *ctx) { pick_open(P_REPLY, false); }
static void chat_click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_SELECT, chat_select);
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, chat_long_select, NULL);
}
static void chat_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  GRect b = layer_get_bounds(root);
  s_scroll = scroll_layer_create(b);
  scroll_layer_set_callbacks(s_scroll, (ScrollLayerCallbacks) { .click_config_provider = chat_click_config });
  scroll_layer_set_click_config_onto_window(s_scroll, w);
  scroll_layer_set_shadow_hidden(s_scroll, true);
#if defined(PBL_ROUND)
  scroll_layer_set_paging(s_scroll, true);
#endif
  s_content = layer_create(GRect(0, 0, b.size.w, 100));
  layer_set_update_proc(s_content, content_update);
  scroll_layer_add_child(s_scroll, s_content);
  layer_add_child(root, scroll_layer_get_layer(s_scroll));
  int bh = PBL_DISPLAY_WIDTH >= 200 ? 30 : 24;
  s_banner = text_layer_create(GRect(0, b.size.h - bh - PBL_IF_ROUND_ELSE(14, 0), b.size.w, bh));
  text_layer_set_background_color(s_banner, FG);
  text_layer_set_text_color(s_banner, BG);
  text_layer_set_font(s_banner, s_font_head);
  text_layer_set_text_alignment(s_banner, GTextAlignmentCenter);
  layer_set_hidden(text_layer_get_layer(s_banner), true);
  layer_add_child(root, text_layer_get_layer(s_banner));
  for (int i = 0; i < s_msg_count; i++) measure(&s_msgs[i]);
  chat_relayout(true);
}
static void chat_unload(Window *w) {
  if (s_banner_timer) { app_timer_cancel(s_banner_timer); s_banner_timer = NULL; }
  text_layer_destroy(s_banner); s_banner = NULL;
  layer_destroy(s_content); s_content = NULL;
  scroll_layer_destroy(s_scroll); s_scroll = NULL;
  window_destroy(w); s_chat_win = NULL;
  send_cmd(C_CLOSE, s_open_chat, NULL);
  s_open_chat[0] = 0;
  msgs_clear();
  if (!s_pick_win) emoji_free();
}
static void watchdog_arm(void);
static void show_load_status(const char *t);
static void chat_open(Chat *c) {
  msgs_clear();
  strncpy(s_open_chat, c->id, sizeof(s_open_chat));
  strncpy(s_open_title, c->title, sizeof(s_open_title));
  s_chat_loading = true;
  s_chat_failed = false;
  watchdog_arm();
  s_chat_win = window_create();
  window_set_background_color(s_chat_win, BG);
  window_set_window_handlers(s_chat_win, (WindowHandlers) { .load = chat_load, .unload = chat_unload });
  window_stack_push(s_chat_win, true);
  if (connection_service_peek_pebble_app_connection()) send_cmd(C_OPEN, c->id, NULL);
  else show_load_status(TR(T_NO_PHONE));
}

/* ------------------------------------------------------ Menüzelle -- */
/* Zeilenhöhe bei Schriftgröße 1/2; rund zeigen nicht markierte Zeilen nur den Titel */
static int16_t cell_h(bool sub, bool focused) {
  if (PBL_IF_ROUND_ELSE(!focused, false)) return MTITLE_H + 6;
  return MTITLE_H + (sub ? MSUB_H[s_look.font] : 0) + 10;
}
static void cell_draw(GContext *ctx, const Layer *cell, const char *title, const char *sub) {
  if (!s_look.font) { menu_cell_basic_draw(ctx, cell, title, sub, NULL); return; }
#if defined(PBL_ROUND)
  if (!menu_cell_layer_is_highlighted(cell)) sub = NULL;
#endif
  GRect b = layer_get_bounds(cell);
  int x = PBL_IF_ROUND_ELSE(12, 5), w = b.size.w - 2 * x;
  int sh = sub ? MSUB_H[s_look.font] : 0, y = (b.size.h - MTITLE_H - sh) / 2 - 4;
  GTextAlignment al = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft);
  graphics_draw_text(ctx, title, s_font_mtitle, GRect(x, y, w, MTITLE_H + 4), GTextOverflowModeTrailingEllipsis, al, NULL);
  if (sub) graphics_draw_text(ctx, sub, s_font_msub, GRect(x, y + MTITLE_H, w, sh + 4), GTextOverflowModeTrailingEllipsis, al, NULL);
}

/* ---------------------------------------------------- Auswahlmenü -- */
static int s_pick_mode;
static int s_pick_focus;   /* Startzeile beim Öffnen */
static Chat s_pick_chat;
#if defined(HAS_SPEAKER)
#define BEEP_ROWS 1
#else
#define BEEP_ROWS 0
#endif
/* Menü im Chat (P_REPLY): oben Emoji, Letzte löschen, Push pausieren – darunter die Schnellantworten.
   Listenmenü (P_LIST): Push pausieren, Piep an/aus. System-Chat: nur lesbar, kein Emoji/Löschen. */
enum { R_EMOJI, R_DELETE, R_PAUSE, R_BEEP, R_QR };
static bool sys_chat(void) { return !strcmp(s_open_chat, "u.watchietalkie"); }
static int pick_opts(void) {
  if (s_pick_mode == P_LIST) return (s_push_avail ? 1 : 0) + BEEP_ROWS;
  return (sys_chat() ? 0 : 2) + (s_push_avail ? 1 : 0);
}
static int row_kind(int r) {
  if (s_pick_mode == P_LIST) return s_push_avail && r == 0 ? R_PAUSE : R_BEEP;
  if (!sys_chat()) { if (r == 0) return R_EMOJI; if (r == 1) return R_DELETE; r -= 2; }
  return s_push_avail && r == 0 ? R_PAUSE : R_QR;
}
static uint16_t pick_rows(MenuLayer *m, uint16_t s, void *ctx) {
  if (s_pick_mode == P_INVITE || s_pick_mode == P_DELETE) return 2;
  if (s_pick_mode == P_EMOJI) return EMOJI_N;
  return pick_opts() + (s_pick_mode == P_REPLY ? s_qr_count : 0);
}
/* Zeile mit Emoji-Bild links vom Titel (Bild nur, wenn die Zeile hoch genug ist) */
static void icon_cell(GContext *ctx, const Layer *cell, int e, const char *title) {
  GRect b = layer_get_bounds(cell);
  GFont f = s_look.font ? s_font_mtitle : fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  int fh = s_look.font ? MTITLE_H : 26, iw = b.size.h >= EMO + 2 ? EMO + 6 : 0;
#if defined(PBL_ROUND)
  int x = (b.size.w - iw - graphics_text_layout_get_content_size(title, f, GRect(0, 0, b.size.w - iw - 10, fh + 4),
                                                   GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft).w) / 2;
#else
  int x = 5;
#endif
  if (iw) emoji_draw(ctx, e, GPoint(x, (b.size.h - EMO) / 2), menu_cell_layer_is_highlighted(cell) ? FG : BG);
  graphics_draw_text(ctx, title, f, GRect(x + iw, (b.size.h - fh) / 2 - 4, b.size.w - x - iw - 2, fh + 4),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}
static void pick_draw(GContext *ctx, const Layer *cell, MenuIndex *idx, void *data) {
  int r = idx->row;
  if (s_pick_mode == P_EMOJI) { icon_cell(ctx, cell, r, EMOJI[r][1]); return; }
  if (s_pick_mode == P_INVITE) { cell_draw(ctx, cell, TR(r == 0 ? T_ACCEPT : T_DECLINE), NULL); return; }
  if (s_pick_mode == P_DELETE) { cell_draw(ctx, cell, TR(r == 0 ? T_DELETE_YES : T_CANCEL), NULL); return; }
  switch (row_kind(r)) {
    case R_EMOJI: icon_cell(ctx, cell, 0, TR(T_EMOJI)); break;
    case R_DELETE: cell_draw(ctx, cell, TR(T_DELETE_LAST), NULL); break;
    case R_PAUSE: {
      static char sub[20];
      if (paused()) { struct tm *t = localtime(&s_pause_until); strftime(sub, sizeof(sub), clock_is_24h_style() ? "paused until %H:%M" : "paused until %I:%M", t); }
      else snprintf(sub, sizeof(sub), "for %d min", s_pause_min);
      cell_draw(ctx, cell, TR(paused() ? T_RESUME : T_PAUSE), sub);
      break;
    }
    case R_BEEP: cell_draw(ctx, cell, TR(s_beep ? T_BEEP_OFF : T_BEEP_ON), NULL); break;
    default: cell_draw(ctx, cell, s_qr[r - pick_opts()], NULL);
  }
}
static int16_t pick_row_h(MenuLayer *m, MenuIndex *idx, void *ctx) {
  bool focused = menu_layer_is_index_selected(m, idx);
  if (s_pick_mode == P_EMOJI) return s_look.font ? cell_h(false, true) : EMO + 10;
  bool reply = s_pick_mode == P_LIST || s_pick_mode == P_REPLY;
  if (reply && row_kind(idx->row) == R_EMOJI) return cell_h(false, true);
  return cell_h(reply && row_kind(idx->row) == R_PAUSE, focused);
}
static void pick_select(MenuLayer *m, MenuIndex *idx, void *ctx);
/* Schriftgröße 0: Standard-Zeilenhöhen des Systems (außer in der Emoji-Auswahl) */
static void pick_callbacks(void) {
  menu_layer_set_callbacks(s_pick_menu, NULL, (MenuLayerCallbacks) { .get_num_rows = pick_rows, .draw_row = pick_draw,
    .select_click = pick_select, .get_cell_height = s_look.font || s_pick_mode == P_EMOJI ? pick_row_h : NULL });
}
static void pick_mode(int mode) {
  s_pick_mode = mode;
  pick_callbacks();
  menu_layer_reload_data(s_pick_menu);
  menu_layer_set_selected_index(s_pick_menu, MenuIndex(0, 0), MenuRowAlignCenter, false);
}
static void pick_send(const char *text) {
  if (!s_open_chat[0]) return;
  msg_append("", text, true);
  chat_relayout(true);
  send_cmd(C_SEND, s_open_chat, text);
}
static void main_reload(void);
static void pick_select(MenuLayer *m, MenuIndex *idx, void *ctx) {
  int r = idx->row;
  if (s_pick_mode == P_INVITE) {
    send_cmd(r == 0 ? C_ACCEPT : C_DECLINE, s_pick_chat.id, NULL);
    snprintf(s_status, sizeof(s_status), "%s", TR(T_LOADING));
  } else if (s_pick_mode == P_EMOJI) {
    pick_send(EMOJI[r][0]);
  } else if (s_pick_mode == P_DELETE) {
    if (r == 0 && s_open_chat[0]) send_cmd(C_DELETE, s_open_chat, NULL);
  } else switch (row_kind(r)) {
    case R_EMOJI: pick_mode(P_EMOJI); return;
    case R_DELETE: pick_mode(P_DELETE); return;
    case R_PAUSE: {                               /* Push pausieren / fortsetzen – Server bestätigt per C_PUSH */
      bool on = !paused();
      s_pause_until = on ? time(NULL) + s_pause_min * 60 : 0;
      send_cmd(C_PAUSE, NULL, on ? "1" : "0");
      vibes_short_pulse();
      main_reload();
      break;
    }
    case R_BEEP:                                  /* Piep an/aus (wie auf der Einstellungsseite) */
      s_beep = !s_beep;
      send_cmd(C_BEEP, NULL, s_beep ? "1" : "0");
      if (s_beep) roger_beep();
      main_reload();
      break;
    default: pick_send(s_qr[r - pick_opts()]);
  }
  window_stack_remove(s_pick_win, true);
}
static void pick_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  s_pick_menu = menu_layer_create(layer_get_bounds(root));
  pick_callbacks();
  menu_layer_set_normal_colors(s_pick_menu, BG, FG);
  menu_layer_set_highlight_colors(s_pick_menu, FG, BG);
  menu_layer_set_click_config_onto_window(s_pick_menu, w);
  if (s_pick_focus > 0 && s_pick_focus < pick_rows(s_pick_menu, 0, NULL))
    menu_layer_set_selected_index(s_pick_menu, MenuIndex(0, s_pick_focus), MenuRowAlignCenter, false);
  layer_add_child(root, menu_layer_get_layer(s_pick_menu));
}
static void pick_unload(Window *w) {
  menu_layer_destroy(s_pick_menu); s_pick_menu = NULL; window_destroy(w); s_pick_win = NULL;
  if (!s_chat_win) emoji_free();
}
/* focus_qr: direkt auf der ersten Schnellantwort starten (Uhr ohne Mikrofon / Diktat fehlgeschlagen) */
static void pick_open(int mode, bool focus_qr) {
  if (s_pick_win) return;
  s_pick_mode = mode;
  s_pick_focus = focus_qr && s_qr_count ? pick_opts() : 0;
  s_pick_win = window_create();
  window_set_window_handlers(s_pick_win, (WindowHandlers) { .load = pick_load, .unload = pick_unload });
  window_stack_push(s_pick_win, true);
}

/* ------------------------------------------------------ Chatliste -- */
static uint16_t main_rows(MenuLayer *m, uint16_t s, void *ctx) { return s_chat_count ? s_chat_count : 1; }
static int16_t main_row_h(MenuLayer *m, MenuIndex *idx, void *ctx) {
  if (!s_chat_count) return layer_get_bounds(menu_layer_get_layer(m)).size.h - PBL_IF_ROUND_ELSE(32 + 24, PBL_DISPLAY_WIDTH >= 200 ? 28 : 22);
  if (s_look.font) return cell_h(true, menu_layer_is_index_selected(m, idx));
  return PBL_IF_ROUND_ELSE(menu_layer_is_index_selected(m, idx) ? 60 : 36, PBL_DISPLAY_WIDTH >= 200 ? 56 : 44);
}
static void main_draw(GContext *ctx, const Layer *cell, MenuIndex *idx, void *data) {
  if (!s_chat_count) {
    GRect b = layer_get_bounds(cell);
    graphics_draw_text(ctx, s_status, s_look.font ? s_font_msub : s_font_head, grect_inset(b, GEdgeInsets(6, 6 + ROUND_INSET)), GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }
  Chat *c = &s_chats[idx->row];
  char title[34];
  if (c->unread) snprintf(title, sizeof(title), "(%d) %s", c->unread, c->title);
  else snprintf(title, sizeof(title), "%s", c->title);
  const char *sub = c->kind == K_CHAT ? c->preview : (c->kind == K_CONTACT_INVITE ? TR(T_CONTACT_REQ) : TR(T_GROUP_INV));
  cell_draw(ctx, cell, title, sub);
}
static int16_t main_header_h(MenuLayer *m, uint16_t s, void *ctx) { return PBL_IF_ROUND_ELSE(32, PBL_DISPLAY_WIDTH >= 200 ? 28 : 22); }
static void main_header(GContext *ctx, const Layer *cell, uint16_t s, void *data) {
  GRect b = layer_get_bounds(cell);
  graphics_context_set_fill_color(ctx, ACCENT);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  /* Schriftzug "WatchieTalkie" weiß, die "2" in Kontrastfarbe */
  const char *name = "WatchieTalkie";
  GSize w1 = graphics_text_layout_get_content_size(name, s_font_head, GRect(0, 0, b.size.w, 30), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  GSize w2 = graphics_text_layout_get_content_size("2", s_font_head, GRect(0, 0, 30, 30), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  int x = (b.size.w - w1.w - w2.w - 1) / 2, y = b.size.h - (PBL_DISPLAY_WIDTH >= 200 ? 24 : 19);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, name, s_font_head, GRect(x, y, w1.w + 2, 22), GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorYellow, GColorWhite));
  graphics_draw_text(ctx, "2", s_font_head, GRect(x + w1.w + 1, y, w2.w + 2, 22), GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
#if defined(HAS_SPEAKER)
  if (!s_beep) {   /* Piep aus: kleiner durchgestrichener Lautsprecher rechts */
    int sx = x + w1.w + w2.w + 8, sy = y + PBL_IF_ROUND_ELSE(5, (PBL_DISPLAY_WIDTH >= 200 ? 7 : 4));
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, GRect(sx, sy + 3, 4, 6), 0, GCornerNone);
    GPathInfo cone = { 4, (GPoint[]) { {sx + 4, sy + 3}, {sx + 9, sy}, {sx + 9, sy + 12}, {sx + 4, sy + 9} } };
    GPath *gp = gpath_create(&cone); gpath_draw_filled(ctx, gp); gpath_destroy(gp);
    graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorYellow, GColorWhite));
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, GPoint(sx - 1, sy + 12), GPoint(sx + 11, sy));
  }
#endif
}
/* Rund: leere Liste (lange Statuszeile) nicht zentrieren, sonst rutscht die Kopfzeile aus dem Bild */
static void main_reload(void) {
  if (!s_menu) return;
#if defined(PBL_ROUND)
  menu_layer_set_center_focused(s_menu, s_chat_count > 0);
#endif
  menu_layer_reload_data(s_menu);
}
static void main_select(MenuLayer *m, MenuIndex *idx, void *ctx) {
  if (!s_chat_count) { send_cmd(C_TEST, NULL, NULL); return; }   /* leere Liste: SELECT holt eine Testnachricht */
  Chat *c = &s_chats[idx->row];
  if (c->kind == K_CHAT) chat_open(c);
  else { s_pick_chat = *c; pick_open(P_INVITE, false); }
}
/* Langes SELECT in der Liste: kleines Menü (Push pausieren, Piep an/aus) – nur wenn es etwas zu wählen gibt */
static void main_long_select(MenuLayer *m, MenuIndex *idx, void *ctx) {
  if (s_push_avail || BEEP_ROWS) pick_open(P_LIST, false);
}
static void main_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  s_menu = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_rows = main_rows, .get_cell_height = main_row_h, .draw_row = main_draw, .select_click = main_select,
    .select_long_click = main_long_select,
    .get_header_height = main_header_h, .draw_header = main_header });
  menu_layer_set_normal_colors(s_menu, BG, FG);
  menu_layer_set_highlight_colors(s_menu, FG, BG);
  menu_layer_set_click_config_onto_window(s_menu, w);
  layer_add_child(root, menu_layer_get_layer(s_menu));
}
static void main_unload(Window *w) { menu_layer_destroy(s_menu); }

/* ------------------------------------------------------- Watchdog -- */
/* Kommt nach einer Anfrage (Start, Chat öffnen) gar nichts vom Handy zurück, nicht ewig „Loading …“ zeigen:
   Meldung anzeigen und die Anfrage wiederholen. Serverfehler meldet und wiederholt das Handy selbst. */
static AppTimer *s_wd_timer;
static uint32_t s_rx, s_rx_mark;
/* Steht gerade „Laden“ auf dem Schirm (leere Liste bzw. Chat lädt)? Dann Meldung t dort anzeigen */
static void show_load_status(const char *t) {
  if (s_chat_win ? !(s_chat_loading || s_chat_failed) : s_chat_count > 0) return;
  snprintf(s_status, sizeof(s_status), "%s", t);
  if (s_chat_win) { s_chat_failed = true; chat_relayout(false); }
  else main_reload();
}
/* Offene Anfrage (Liste bzw. Chat) neu stellen */
static void request_again(void) {
  if (s_chat_win) send_cmd(C_OPEN, s_open_chat, NULL);
  else send_cmd(C_READY, NULL, NULL);
}
static void watchdog_fire(void *ctx) {
  s_wd_timer = NULL;
  if (s_rx != s_rx_mark) return;                 /* Handy hat geantwortet */
  show_load_status(TR(connection_service_peek_pebble_app_connection() ? T_NO_ANSWER : T_NO_PHONE));
  if (s_chat_win && !s_chat_loading) return;
  request_again();
  s_wd_timer = app_timer_register(30000, watchdog_fire, NULL);
}
static void watchdog_arm(void) {
  s_rx_mark = s_rx;
  if (s_wd_timer) app_timer_cancel(s_wd_timer);
  s_wd_timer = app_timer_register(20000, watchdog_fire, NULL);
}
/* Verbindung zum Handy: getrennt → sofort Meldung statt „Loading …“; wieder da → neu laden */
static void conn_changed(bool up) {
  if (!up) {
    show_load_status(TR(T_NO_PHONE));
    if (s_chat_win && !s_chat_failed) banner_show(TR(T_PHONE_LOST));
    return;
  }
  show_load_status(TR(T_LOADING));
  if (s_chat_win && s_chat_failed) { s_chat_failed = false; s_chat_loading = true; chat_relayout(false); }
  request_again();
  watchdog_arm();
}

/* -------------------------------------------------------- Aussehen -- */
static void look_apply(bool light_was) {
  if (s_look.font > 2) s_look.font = 0;
#if !defined(PBL_COLOR)
  s_look.bg = s_look.bg == 0xFF ? 0xFF : 0xC0;       /* S/W: nur Weiß oder Schwarz, Schrift immer die Gegenfarbe */
  s_look.fg = s_look.bg ^ 0x3F;
#endif
  s_font_body = fonts_get_system_font(FONT_BODY[s_look.font]);
  s_font_name = fonts_get_system_font(FONT_NAME[s_look.font]);
  s_name_h = NAME_H[s_look.font];
  if (s_look.font) { s_font_mtitle = fonts_get_system_font(FONT_MTITLE[s_look.font]); s_font_msub = fonts_get_system_font(FONT_MSUB[s_look.font]); }
  for (int i = 0; i < s_msg_count; i++) measure(&s_msgs[i]);
  if (s_menu) { menu_layer_set_normal_colors(s_menu, BG, FG); menu_layer_set_highlight_colors(s_menu, FG, BG); main_reload(); }
  if (s_pick_menu) { menu_layer_set_normal_colors(s_pick_menu, BG, FG); menu_layer_set_highlight_colors(s_pick_menu, FG, BG); pick_callbacks(); menu_layer_reload_data(s_pick_menu); }
  if (s_chat_win) {
    window_set_background_color(s_chat_win, BG);
    text_layer_set_background_color(s_banner, FG); text_layer_set_text_color(s_banner, BG);
    chat_relayout(false);
  }
  if (s_look.light) light_enable(true);               /* Licht bleibt an, solange die App offen ist */
  else if (light_was) light_enable(false);            /* zurück auf automatisch */
}

/* ------------------------------------------------------ Empfangen -- */
static const char *str(DictionaryIterator *it, uint32_t key) { Tuple *t = dict_find(it, key); return t ? t->value->cstring : ""; }
static int num(DictionaryIterator *it, uint32_t key) { Tuple *t = dict_find(it, key); return t ? (int)t->value->int32 : 0; }
static void copy(char *dst, size_t n, const char *src) { strncpy(dst, src, n - 1); dst[n - 1] = 0; }

static void inbox(DictionaryIterator *it, void *ctx) {
  int cmd = num(it, MESSAGE_KEY_CMD), idx = num(it, MESSAGE_KEY_IDX), count = num(it, MESSAGE_KEY_COUNT);
  s_rx++;
  switch (cmd) {
    case C_LIST_ITEM: {
      /* Erst nach dem letzten Eintrag übernehmen – sonst springt die Markierung beim Nachladen (neue Nachricht) */
      static int s_load_n;
      if (idx == 0) s_load_n = 0;
      if (count == 0) { s_chat_count = 0; main_reload(); break; }
      if (idx < MAX_CHATS && idx == s_load_n) {
        Chat *c = &s_chats[s_load_n++];
        copy(c->id, sizeof(c->id), str(it, MESSAGE_KEY_CHAT));
        copy(c->title, sizeof(c->title), str(it, MESSAGE_KEY_TITLE));
        copy(c->preview, sizeof(c->preview), str(it, MESSAGE_KEY_TEXT));
        c->unread = num(it, MESSAGE_KEY_UNREAD);
        c->kind = num(it, MESSAGE_KEY_KIND);
      }
      if (idx == count - 1 || idx == MAX_CHATS - 1) { s_chat_count = s_load_n; main_reload(); }
      break;
    }
    case C_MSG_ITEM:
      if (strcmp(str(it, MESSAGE_KEY_CHAT), s_open_chat) != 0) break;
      if (idx == 0) msgs_clear();
      s_chat_loading = false;
      s_chat_failed = false;
      if (count > 0 && idx == s_msg_count && idx < MAX_MSGS)
        msg_set(&s_msgs[s_msg_count++], str(it, MESSAGE_KEY_FROM), str(it, MESSAGE_KEY_TEXT), num(it, MESSAGE_KEY_FLAGS) & 1);
      if (!s_chat_win) break;
      if (count == 0 || idx == count - 1 || idx == MAX_MSGS - 1) chat_relayout(true);
      break;
    case C_NEW_MSG: {
      bool here = s_chat_win && strcmp(str(it, MESSAGE_KEY_CHAT), s_open_chat) == 0;
      if (here) { msg_append(str(it, MESSAGE_KEY_FROM), str(it, MESSAGE_KEY_TEXT), false); chat_relayout(true); }
      if (s_vibe && !quiet_time_is_active()) vibes_short_pulse();   /* Ruhemodus: weder Vibration noch Piep */
      roger_beep();
      if (!here && s_chat_win) {
        static char b[48];
        snprintf(b, sizeof(b), TR(T_NEW_FROM), str(it, MESSAGE_KEY_FROM));
        banner_show(b);
      }
      break;
    }
    case C_QR_ITEM:
      if (idx == 0) { for (int i = 0; i < s_qr_count; i++) free(s_qr[i]); s_qr_count = 0; }
      s_vibe = num(it, MESSAGE_KEY_FLAGS) & 1;
      s_beep = (num(it, MESSAGE_KEY_FLAGS) & 2) != 0;
      if (count > 0 && idx == s_qr_count && idx < MAX_QR) {
        const char *t = str(it, MESSAGE_KEY_TEXT);
        s_qr[s_qr_count] = malloc(strlen(t) + 1);
        if (s_qr[s_qr_count]) strcpy(s_qr[s_qr_count++], t);
      }
      break;
    case C_STATUS:
      copy(s_status, sizeof(s_status), str(it, MESSAGE_KEY_TEXT));
      if (s_chat_win) {
        if (s_chat_loading || s_chat_failed) { s_chat_failed = true; chat_relayout(false); }   /* Fehler bleibt sichtbar, bis Nachrichten kommen */
        else banner_show(s_status);
      }
      main_reload();
      break;
    case C_PUSH:                                  /* FLAGS: Push eingerichtet · IDX: Pause-Restminuten · COUNT: Pausendauer */
      s_push_avail = num(it, MESSAGE_KEY_FLAGS) & 1;
      s_pause_until = idx > 0 ? time(NULL) + idx * 60 : 0;
      if (count > 0) s_pause_min = count;
      if (s_pick_menu) menu_layer_reload_data(s_pick_menu);
      main_reload();
      break;
    case C_LOOK: {                                /* IDX: Schriftgröße · COUNT: Hintergrund << 8 | Schrift (GColor8) · FLAGS: Licht an */
      bool light_was = s_look.light;
      int c = num(it, MESSAGE_KEY_COUNT);
      s_look = (Look) { idx, (c >> 8) & 0xFF, c & 0xFF, num(it, MESSAGE_KEY_FLAGS) & 1 };
      look_apply(light_was);
      persist_write_data(PERSIST_LOOK, &s_look, sizeof(s_look));
      break;
    }
    case C_SENT:
      if (!(num(it, MESSAGE_KEY_FLAGS) & 1)) { vibes_double_pulse(); banner_show(str(it, MESSAGE_KEY_TEXT)[0] ? str(it, MESSAGE_KEY_TEXT) : TR(T_SEND_FAILED)); }
      break;
  }
}

static void init(void) {
  snprintf(s_status, sizeof(s_status), "%s", TR(T_CONNECTING));   /* bis das Handy antwortet */
  s_font_head = fonts_get_system_font(FONT_HEAD);
  if (persist_exists(PERSIST_LOOK)) persist_read_data(PERSIST_LOOK, &s_look, sizeof(s_look));
  look_apply(false);
  app_message_register_inbox_received(inbox);
  app_message_register_outbox_sent(out_sent);
  app_message_register_outbox_failed(out_failed);
  app_message_open(PBL_IF_ROUND_ELSE(1024, PBL_IF_COLOR_ELSE(1024, 700)), 640);
#if defined(PBL_MICROPHONE)
  s_dict = dictation_session_create(TEXT_BYTES, dict_done, NULL);
  if (s_dict) dictation_session_enable_confirmation(s_dict, true);
#endif
  s_main_win = window_create();
  window_set_window_handlers(s_main_win, (WindowHandlers) { .load = main_load, .unload = main_unload });
  window_stack_push(s_main_win, true);
  connection_service_subscribe((ConnectionHandlers) { .pebble_app_connection_handler = conn_changed });
  if (connection_service_peek_pebble_app_connection()) { send_cmd(C_READY, NULL, NULL); watchdog_arm(); }
  else show_load_status(TR(T_NO_PHONE));
}
static void deinit(void) {
#if defined(PBL_MICROPHONE)
  if (s_dict) dictation_session_destroy(s_dict);
#endif
  window_destroy(s_main_win);
  if (s_look.light) light_enable(false);
  msgs_clear();
  for (int i = 0; i < s_qr_count; i++) free(s_qr[i]);
}
int main(void) { init(); app_event_loop(); deinit(); }
