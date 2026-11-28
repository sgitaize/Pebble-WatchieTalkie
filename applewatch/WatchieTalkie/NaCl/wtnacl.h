/* Schmale Hülle um TweetNaCl (public domain): Formate wie tweetnacl-js (nacl.box / nacl.secretbox ohne Null-Polster). */
#ifndef WTNACL_H
#define WTNACL_H
#include <stdint.h>
#include <stddef.h>
/* Ausgabe: len + 16 Byte (Poly1305-Tag vorne, wie tweetnacl-js) */
int wt_secretbox(uint8_t *out, const uint8_t *msg, size_t len, const uint8_t nonce[24], const uint8_t key[32]);
/* Eingabe clen ≥ 16; Ausgabe clen − 16 Byte; 0 = echt, sonst Fälschung/Fehler */
int wt_secretbox_open(uint8_t *out, const uint8_t *c, size_t clen, const uint8_t nonce[24], const uint8_t key[32]);
int wt_box(uint8_t *out, const uint8_t *msg, size_t len, const uint8_t nonce[24], const uint8_t pk[32], const uint8_t sk[32]);
int wt_box_open(uint8_t *out, const uint8_t *c, size_t clen, const uint8_t nonce[24], const uint8_t pk[32], const uint8_t sk[32]);
void wt_public_key(uint8_t pk[32], const uint8_t sk[32]);
void wt_sha512(uint8_t out[64], const uint8_t *m, size_t len);
void wt_random(uint8_t *out, size_t len);
#endif
