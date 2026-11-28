#include "wtnacl.h"
#include "tweetnacl.h"
#include <stdlib.h>
#include <string.h>
#include <Security/SecRandom.h>

/* Zufall für TweetNaCl (wird hier nur von crypto_box_keypair gebraucht – wir nutzen ihn nicht, aber der Linker will ihn) */
void randombytes(unsigned char *x, unsigned long long n) { wt_random(x, (size_t)n); }
void wt_random(uint8_t *out, size_t len) {
  if (SecRandomCopyBytes(kSecRandomDefault, len, out) != errSecSuccess) arc4random_buf(out, len);
}

/* TweetNaCl will vorne 32 Null-Bytes am Klartext und liefert 16 Null-Bytes vor dem Chiffretext */
static int seal(int box, uint8_t *out, const uint8_t *msg, size_t len, const uint8_t *nonce, const uint8_t *k1, const uint8_t *k2) {
  size_t n = len + 32;
  uint8_t *m = calloc(n, 1), *c = calloc(n, 1);
  if (!m || !c) { free(m); free(c); return -1; }
  memcpy(m + 32, msg, len);
  int r = box ? crypto_box(c, m, n, nonce, k1, k2) : crypto_secretbox(c, m, n, nonce, k1);
  if (!r) memcpy(out, c + 16, len + 16);
  memset(m, 0, n); free(m); free(c);
  return r;
}
static int unseal(int box, uint8_t *out, const uint8_t *cin, size_t clen, const uint8_t *nonce, const uint8_t *k1, const uint8_t *k2) {
  if (clen < 16) return -1;
  size_t n = clen + 16;
  uint8_t *c = calloc(n, 1), *m = calloc(n, 1);
  if (!m || !c) { free(m); free(c); return -1; }
  memcpy(c + 16, cin, clen);
  int r = box ? crypto_box_open(m, c, n, nonce, k1, k2) : crypto_secretbox_open(m, c, n, nonce, k1);
  if (!r) memcpy(out, m + 32, clen - 16);
  memset(m, 0, n); free(m); free(c);
  return r;
}
int wt_secretbox(uint8_t *out, const uint8_t *msg, size_t len, const uint8_t nonce[24], const uint8_t key[32]) { return seal(0, out, msg, len, nonce, key, NULL); }
int wt_secretbox_open(uint8_t *out, const uint8_t *c, size_t clen, const uint8_t nonce[24], const uint8_t key[32]) { return unseal(0, out, c, clen, nonce, key, NULL); }
int wt_box(uint8_t *out, const uint8_t *msg, size_t len, const uint8_t nonce[24], const uint8_t pk[32], const uint8_t sk[32]) { return seal(1, out, msg, len, nonce, pk, sk); }
int wt_box_open(uint8_t *out, const uint8_t *c, size_t clen, const uint8_t nonce[24], const uint8_t pk[32], const uint8_t sk[32]) { return unseal(1, out, c, clen, nonce, pk, sk); }
void wt_public_key(uint8_t pk[32], const uint8_t sk[32]) { crypto_scalarmult_base(pk, sk); }
void wt_sha512(uint8_t out[64], const uint8_t *m, size_t len) { crypto_hash(out, m, len); }
