/*
 * WatchieTalkie2 – Walkie-Talkie mit Textnachrichten für die Pebble (Weiterführung des früheren Watchie-Talkie).
 * Die Uhr zeigt nur an und nimmt Sprache/Schnellantworten entgegen; alles Netzwerk macht PebbleKit JS (src/pkjs).
 */
#include <pebble.h>

/* Befehle pkjs → Uhr */
enum { C_LIST_ITEM = 2, C_MSG_ITEM = 5, C_NEW_MSG = 7, C_QR_ITEM = 8, C_STATUS = 9, C_SENT = 10 };
/* Befehle Uhr → pkjs */
enum { C_READY = 20, C_OPEN = 21, C_SEND = 22, C_CLOSE = 23, C_ACCEPT = 24, C_DECLINE = 25 };
/* Art eines Listeneintrags */
enum { K_CHAT = 0, K_CONTACT_INVITE = 1, K_GROUP_INVITE = 2 };

#if defined(PBL_PLATFORM_APLITE)
#define MAX_MSGS 10
#define MAX_CHATS 12
#else
#define MAX_MSGS 30
#define MAX_CHATS 20
#endif
#define MAX_QR 10
#define TEXT_BYTES 512

#if PBL_DISPLAY_WIDTH >= 200
#define FONT_BODY FONT_KEY_GOTHIC_24
#define FONT_HEAD FONT_KEY_GOTHIC_18_BOLD
#else
#define FONT_BODY FONT_KEY_GOTHIC_18
#define FONT_HEAD FONT_KEY_GOTHIC_14_BOLD
#endif
#define PAD 4
#define ACCENT PBL_IF_COLOR_ELSE(GColorSunsetOrange, GColorBlack)
#define ROUND_INSET PBL_IF_ROUND_ELSE(22, 0)
#define TOP (PBL_IF_ROUND_ELSE(36, 2) + (PBL_DISPLAY_WIDTH >= 200 ? 26 : 22))

typedef struct { char id[20]; char title[26]; char preview[44]; uint8_t unread; uint8_t kind; } Chat;
typedef struct { char *text; char from[17]; bool mine; int16_t h; } Msg;

static Chat s_chats[MAX_CHATS];
static int s_chat_count;
/* Texte: Deutsch, wenn die Uhr auf Deutsch steht, sonst Englisch */
static bool s_de;
enum { T_LOADING, T_EMPTY_CHAT, T_NO_QR, T_ACCEPT, T_DECLINE, T_CONTACT_REQ, T_GROUP_INV, T_NO_VOICE, T_NEW_FROM, T_SEND_FAILED };
static const char *T_DE[] = { "Lade …", "Noch keine Nachrichten.\nSELECT: sprechen\nlang SELECT: Schnellantwort", "Keine Schnellantworten",
  "Annehmen", "Ablehnen", "Kontaktanfrage", "Gruppeneinladung", "Sprache nicht verfügbar", "Neu von %s", "Senden fehlgeschlagen" };
static const char *T_EN[] = { "Loading …", "No messages yet.\nSELECT: speak\nhold SELECT: quick reply", "No quick replies",
  "Accept", "Decline", "Contact request", "Group invitation", "Voice not available", "New from %s", "Sending failed" };
#define TR(i) (s_de ? T_DE[i] : T_EN[i])
static char s_status[64] = "…";

static Msg s_msgs[MAX_MSGS];
static int s_msg_count;
static char s_open_chat[20];
static char s_open_title[26];
static bool s_chat_loading;

static char *s_qr[MAX_QR];
static int s_qr_count;
static bool s_vibe = true;

static Window *s_main_win, *s_chat_win, *s_pick_win;
static MenuLayer *s_menu, *s_pick_menu;
static ScrollLayer *s_scroll;
static Layer *s_content;
static TextLayer *s_banner;
static AppTimer *s_banner_timer;
static GFont s_font_body, s_font_head;
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

/* ------------------------------------------------------------- Chat -- */
static int text_width(void) {
  return PBL_DISPLAY_WIDTH - 2 * PAD - 2 * ROUND_INSET - 24;
}
static void measure(Msg *m) {
  GSize s = graphics_text_layout_get_content_size(m->text ? m->text : "", s_font_body, GRect(0, 0, text_width(), 2000),
                                                  GTextOverflowModeWordWrap, GTextAlignmentLeft);
  m->h = s.h + (m->mine ? 0 : (PBL_DISPLAY_WIDTH >= 200 ? 20 : 16)) + 2 * PAD + 6;
}
static int content_height(void) {
  int h = TOP;
  if (!s_msg_count) return h + (PBL_DISPLAY_WIDTH >= 200 ? 120 : 90);
  for (int i = 0; i < s_msg_count; i++) h += s_msgs[i].h;
  return h + PBL_IF_ROUND_ELSE(40, 10);
}
static void content_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int x0 = PAD + ROUND_INSET, w = b.size.w - 2 * x0;
  int y = TOP;
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, s_open_title, s_font_head, GRect(x0, y - (PBL_DISPLAY_WIDTH >= 200 ? 26 : 22), w, 24),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  if (!s_msg_count) {
    graphics_draw_text(ctx, s_chat_loading ? TR(T_LOADING) : TR(T_EMPTY_CHAT),
                       s_font_body, GRect(x0, y, w, 200), GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }
  for (int i = 0; i < s_msg_count; i++) {
    Msg *m = &s_msgs[i];
    int bw = w - 12, bx = m->mine ? x0 + 12 : x0;
    GRect bubble = GRect(bx, y + 2, bw, m->h - 6);
#if defined(PBL_COLOR)
    graphics_context_set_fill_color(ctx, m->mine ? GColorMelon : GColorLightGray);
    graphics_fill_rect(ctx, bubble, 6, GCornersAll);
#else
    graphics_context_set_stroke_color(ctx, GColorBlack);
    if (m->mine) { graphics_context_set_fill_color(ctx, GColorBlack); graphics_fill_rect(ctx, bubble, 6, GCornersAll); }
    else graphics_draw_round_rect(ctx, bubble, 6);
    graphics_context_set_text_color(ctx, m->mine ? GColorWhite : GColorBlack);
#endif
    int ty = y + 2 + PAD - 3;
    if (!m->mine) {
      graphics_draw_text(ctx, m->from, s_font_head, GRect(bx + 6, ty, bw - 12, 22), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      ty += PBL_DISPLAY_WIDTH >= 200 ? 20 : 16;
    }
    graphics_draw_text(ctx, m->text ? m->text : "", s_font_body, GRect(bx + 6, ty, bw - 12, 2000), GTextOverflowModeWordWrap,
                       m->mine ? GTextAlignmentRight : GTextAlignmentLeft, NULL);
#if !defined(PBL_COLOR)
    graphics_context_set_text_color(ctx, GColorBlack);
#endif
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

static void pick_open(int mode);
static void start_talk(void) {
#if defined(PBL_MICROPHONE)
  if (s_dict && dictation_session_start(s_dict) == DictationSessionStatusSuccess) return;
#endif
  pick_open(0);
}
#if defined(PBL_MICROPHONE)
static void dict_done(DictationSession *session, DictationSessionStatus status, char *text, void *ctx) {
  if (status == DictationSessionStatusSuccess && text && text[0]) {
    msg_append("", text, true);
    chat_relayout(true);
    send_cmd(C_SEND, s_open_chat, text);
  } else if (status != DictationSessionStatusFailureTranscriptionRejected) {
    banner_show(TR(T_NO_VOICE));
    pick_open(0);
  }
}
#endif
static void chat_select(ClickRecognizerRef r, void *ctx) { start_talk(); }
static void chat_long_select(ClickRecognizerRef r, void *ctx) { pick_open(0); }
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
  text_layer_set_background_color(s_banner, GColorBlack);
  text_layer_set_text_color(s_banner, GColorWhite);
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
}
static void chat_open(Chat *c) {
  msgs_clear();
  strncpy(s_open_chat, c->id, sizeof(s_open_chat));
  strncpy(s_open_title, c->title, sizeof(s_open_title));
  s_chat_loading = true;
  s_chat_win = window_create();
  window_set_window_handlers(s_chat_win, (WindowHandlers) { .load = chat_load, .unload = chat_unload });
  window_stack_push(s_chat_win, true);
  send_cmd(C_OPEN, c->id, NULL);
}

/* ---------------------------------------------------- Auswahlmenü -- */
/* mode 0: Schnellantwort senden · mode 1: Einladung annehmen/ablehnen */
static int s_pick_mode;
static Chat s_pick_chat;
static uint16_t pick_rows(MenuLayer *m, uint16_t s, void *ctx) {
  if (s_pick_mode == 1) return 2;
  return s_qr_count ? s_qr_count : 1;
}
static void pick_draw(GContext *ctx, const Layer *cell, MenuIndex *idx, void *data) {
  const char *t = s_pick_mode == 1 ? TR(idx->row == 0 ? T_ACCEPT : T_DECLINE) : (s_qr_count ? s_qr[idx->row] : TR(T_NO_QR));
  menu_cell_basic_draw(ctx, cell, t, NULL, NULL);
}
static void pick_select(MenuLayer *m, MenuIndex *idx, void *ctx) {
  if (s_pick_mode == 1) {
    send_cmd(idx->row == 0 ? C_ACCEPT : C_DECLINE, s_pick_chat.id, NULL);
    snprintf(s_status, sizeof(s_status), "%s", TR(T_LOADING));
  } else if (s_qr_count && s_open_chat[0]) {
    msg_append("", s_qr[idx->row], true);
    chat_relayout(true);
    send_cmd(C_SEND, s_open_chat, s_qr[idx->row]);
  }
  window_stack_remove(s_pick_win, true);
}
static void pick_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  s_pick_menu = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_pick_menu, NULL, (MenuLayerCallbacks) { .get_num_rows = pick_rows, .draw_row = pick_draw, .select_click = pick_select });
#if defined(PBL_COLOR)
  menu_layer_set_highlight_colors(s_pick_menu, ACCENT, GColorWhite);
#endif
  menu_layer_set_click_config_onto_window(s_pick_menu, w);
  layer_add_child(root, menu_layer_get_layer(s_pick_menu));
}
static void pick_unload(Window *w) { menu_layer_destroy(s_pick_menu); s_pick_menu = NULL; window_destroy(w); s_pick_win = NULL; }
static void pick_open(int mode) {
  if (s_pick_win) return;
  s_pick_mode = mode;
  s_pick_win = window_create();
  window_set_window_handlers(s_pick_win, (WindowHandlers) { .load = pick_load, .unload = pick_unload });
  window_stack_push(s_pick_win, true);
}

/* ------------------------------------------------------ Chatliste -- */
static uint16_t main_rows(MenuLayer *m, uint16_t s, void *ctx) { return s_chat_count ? s_chat_count : 1; }
static int16_t main_row_h(MenuLayer *m, MenuIndex *idx, void *ctx) {
  if (!s_chat_count) return PBL_DISPLAY_WIDTH >= 200 ? 150 : 110;
  return PBL_IF_ROUND_ELSE(menu_layer_is_index_selected(m, idx) ? 60 : 36, PBL_DISPLAY_WIDTH >= 200 ? 56 : 44);
}
static void main_draw(GContext *ctx, const Layer *cell, MenuIndex *idx, void *data) {
  if (!s_chat_count) {
    GRect b = layer_get_bounds(cell);
    graphics_draw_text(ctx, s_status, s_font_head, grect_inset(b, GEdgeInsets(6, 6 + ROUND_INSET)), GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }
  Chat *c = &s_chats[idx->row];
  char title[34];
  if (c->unread) snprintf(title, sizeof(title), "(%d) %s", c->unread, c->title);
  else snprintf(title, sizeof(title), "%s", c->title);
  const char *sub = c->kind == K_CHAT ? c->preview : (c->kind == K_CONTACT_INVITE ? TR(T_CONTACT_REQ) : TR(T_GROUP_INV));
  menu_cell_basic_draw(ctx, cell, title, sub, NULL);
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
}
static void main_select(MenuLayer *m, MenuIndex *idx, void *ctx) {
  if (!s_chat_count) return;
  Chat *c = &s_chats[idx->row];
  if (c->kind == K_CHAT) chat_open(c);
  else { s_pick_chat = *c; pick_open(1); }
}
static void main_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  s_menu = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_rows = main_rows, .get_cell_height = main_row_h, .draw_row = main_draw, .select_click = main_select,
    .get_header_height = main_header_h, .draw_header = main_header });
#if defined(PBL_COLOR)
  menu_layer_set_highlight_colors(s_menu, ACCENT, GColorWhite);
#endif
  menu_layer_set_click_config_onto_window(s_menu, w);
  layer_add_child(root, menu_layer_get_layer(s_menu));
}
static void main_unload(Window *w) { menu_layer_destroy(s_menu); }

/* ------------------------------------------------------ Empfangen -- */
static const char *str(DictionaryIterator *it, uint32_t key) { Tuple *t = dict_find(it, key); return t ? t->value->cstring : ""; }
static int num(DictionaryIterator *it, uint32_t key) { Tuple *t = dict_find(it, key); return t ? (int)t->value->int32 : 0; }
static void copy(char *dst, size_t n, const char *src) { strncpy(dst, src, n - 1); dst[n - 1] = 0; }

static void inbox(DictionaryIterator *it, void *ctx) {
  int cmd = num(it, MESSAGE_KEY_CMD), idx = num(it, MESSAGE_KEY_IDX), count = num(it, MESSAGE_KEY_COUNT);
  switch (cmd) {
    case C_LIST_ITEM:
      if (idx == 0) s_chat_count = 0;
      if (count == 0) s_chat_count = 0;
      else if (idx < MAX_CHATS && idx == s_chat_count) {
        Chat *c = &s_chats[s_chat_count++];
        copy(c->id, sizeof(c->id), str(it, MESSAGE_KEY_CHAT));
        copy(c->title, sizeof(c->title), str(it, MESSAGE_KEY_TITLE));
        copy(c->preview, sizeof(c->preview), str(it, MESSAGE_KEY_TEXT));
        c->unread = num(it, MESSAGE_KEY_UNREAD);
        c->kind = num(it, MESSAGE_KEY_KIND);
      }
      if (s_menu) menu_layer_reload_data(s_menu);
      break;
    case C_MSG_ITEM:
      if (strcmp(str(it, MESSAGE_KEY_CHAT), s_open_chat) != 0) break;
      if (idx == 0) msgs_clear();
      s_chat_loading = false;
      if (count > 0 && idx == s_msg_count && idx < MAX_MSGS)
        msg_set(&s_msgs[s_msg_count++], str(it, MESSAGE_KEY_FROM), str(it, MESSAGE_KEY_TEXT), num(it, MESSAGE_KEY_FLAGS) & 1);
      if (!s_chat_win) break;
      if (count == 0 || idx == count - 1 || idx == MAX_MSGS - 1) chat_relayout(true);
      break;
    case C_NEW_MSG: {
      bool here = s_chat_win && strcmp(str(it, MESSAGE_KEY_CHAT), s_open_chat) == 0;
      if (here) { msg_append(str(it, MESSAGE_KEY_FROM), str(it, MESSAGE_KEY_TEXT), false); chat_relayout(true); }
      if (s_vibe) vibes_short_pulse();
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
      if (count > 0 && idx == s_qr_count && idx < MAX_QR) {
        const char *t = str(it, MESSAGE_KEY_TEXT);
        s_qr[s_qr_count] = malloc(strlen(t) + 1);
        if (s_qr[s_qr_count]) strcpy(s_qr[s_qr_count++], t);
      }
      break;
    case C_STATUS:
      copy(s_status, sizeof(s_status), str(it, MESSAGE_KEY_TEXT));
      if (s_chat_win) { if (s_chat_loading) { s_chat_loading = false; chat_relayout(false); } banner_show(s_status); }
      if (s_menu) menu_layer_reload_data(s_menu);
      break;
    case C_SENT:
      if (!(num(it, MESSAGE_KEY_FLAGS) & 1)) { vibes_double_pulse(); banner_show(str(it, MESSAGE_KEY_TEXT)[0] ? str(it, MESSAGE_KEY_TEXT) : TR(T_SEND_FAILED)); }
      break;
  }
}

static void init(void) {
  s_de = strncmp(i18n_get_system_locale(), "de", 2) == 0;
  snprintf(s_status, sizeof(s_status), "%s", TR(T_LOADING));
  s_font_body = fonts_get_system_font(FONT_BODY);
  s_font_head = fonts_get_system_font(FONT_HEAD);
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
  send_cmd(C_READY, NULL, NULL);
}
static void deinit(void) {
#if defined(PBL_MICROPHONE)
  if (s_dict) dictation_session_destroy(s_dict);
#endif
  window_destroy(s_main_win);
  msgs_clear();
  for (int i = 0; i < s_qr_count; i++) free(s_qr[i]);
}
int main(void) { init(); app_event_loop(); deinit(); }
