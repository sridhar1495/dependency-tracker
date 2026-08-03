#!/usr/bin/env bash
# End-to-end walk of the phase 2 authentication API.
B=http://127.0.0.1:3099
J='Content-Type: application/json'
pass=0; fail=0

chk() { # chk <label> <expected-status> <actual-status> [extra]
  if [ "$2" = "$3" ]; then printf '  \033[0;32mPASS\033[0m %-52s %s\n' "$1" "$3"; pass=$((pass+1));
  else printf '  \033[0;31mFAIL\033[0m %-52s got %s want %s  %s\n' "$1" "$3" "$2" "$4"; fail=$((fail+1)); fi
}
code() { curl -s -o /tmp/body -w '%{http_code}' "$@"; }
body() { cat /tmp/body; }

echo "── Registration validation ──────────────────────────────────────────────"
chk "short first name rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Al","lastName":"Smith","loginId":"alice","password":"password123"}' $B/auth/register)"
chk "digits in name rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Al1ce","lastName":"Smith","loginId":"alice","password":"password123"}' $B/auth/register)"
chk "leading space in name rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":" Alice","lastName":"Smith","loginId":"alice","password":"password123"}' $B/auth/register)"
chk "space in login ID rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Alice","lastName":"Smith","loginId":"al ice","password":"password123"}' $B/auth/register)"
chk "7-char password rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Alice","lastName":"Smith","loginId":"alice","password":"passwor"}' $B/auth/register)"
chk "space in password rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Alice","lastName":"Smith","loginId":"alice","password":"pass word1"}' $B/auth/register)"
chk "bad email rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Alice","lastName":"Smith","loginId":"alice","email":"nope","password":"password123"}' $B/auth/register)"
chk "reserved login 'admin' rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Alice","lastName":"Smith","loginId":"admin","password":"password123"}' $B/auth/register)"
chk "reserved login 'root' rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Alice","lastName":"Smith","loginId":"root","password":"password123"}' $B/auth/register)"
chk "mismatched confirm rejected" 400 "$(code -X POST -H "$J" -d '{"firstName":"Alice","lastName":"Smith","loginId":"alice","password":"password123","confirmPassword":"different1"}' $B/auth/register)"

echo "── Valid registrations ──────────────────────────────────────────────────"
chk "unicode name accepted" 201 "$(code -X POST -H "$J" -d '{"firstName":"José","lastName":"Müller","loginId":"jose","email":"jose@example.com","password":"password123"}' $B/auth/register)"
chk "two-word name accepted" 201 "$(code -X POST -H "$J" -d '{"firstName":"Mary Jane","lastName":"Watson","loginId":"alice","email":"alice@example.com","password":"password123","confirmPassword":"password123"}' $B/auth/register)"
chk "no email accepted (optional)" 201 "$(code -X POST -H "$J" -d '{"firstName":"Bobby","lastName":"Tables","loginId":"bob","password":"password123"}' $B/auth/register)"
chk "duplicate login ID -> 409" 409 "$(code -X POST -H "$J" -d '{"firstName":"Other","lastName":"Person","loginId":"ALICE","password":"password123"}' $B/auth/register)"
echo "     duplicate message: $(body | head -c 90)"
chk "duplicate email -> 409" 409 "$(code -X POST -H "$J" -d '{"firstName":"Other","lastName":"Person","loginId":"other","email":"ALICE@example.com","password":"password123"}' $B/auth/register)"

echo "── Availability check ───────────────────────────────────────────────────"
code -X POST -H "$J" -d '{"field":"loginId","value":"alice"}' $B/auth/check-availability >/dev/null
echo "     taken login   -> $(body)"
code -X POST -H "$J" -d '{"field":"loginId","value":"brandnew"}' $B/auth/check-availability >/dev/null
echo "     free login    -> $(body)"
code -X POST -H "$J" -d '{"field":"email","value":"ALICE@example.com"}' $B/auth/check-availability >/dev/null
echo "     taken email   -> $(body)"

echo "── Login ────────────────────────────────────────────────────────────────"
chk "wrong password -> 401" 401 "$(code -X POST -H "$J" -d '{"loginId":"alice","password":"wrongpass1"}' $B/auth/login)"
echo "     message: $(body)"
chk "unknown user -> 401 (same message)" 401 "$(code -X POST -H "$J" -d '{"loginId":"ghost","password":"wrongpass1"}' $B/auth/login)"
echo "     message: $(body)"
chk "valid login -> 200" 200 "$(code -X POST -H "$J" -d '{"loginId":"alice","password":"password123"}' $B/auth/login)"
TOKEN=$(body | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
echo "     token length: ${#TOKEN}"
echo "     user: $(body | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).user)))")"

echo "── Single active session ────────────────────────────────────────────────"
chk "second login -> 409 SESSION_EXISTS" 409 "$(code -X POST -H "$J" -d '{"loginId":"alice","password":"password123"}' $B/auth/login)"
echo "     $(body | head -c 150)"
chk "forced login -> 200" 200 "$(code -X POST -H "$J" -d '{"loginId":"alice","password":"password123","force":true}' $B/auth/login)"
TOKEN2=$(body | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
chk "OLD token now rejected -> 401" 401 "$(code -H "Authorization: Bearer $TOKEN" $B/auth/me)"
chk "new token works -> 200" 200 "$(code -H "Authorization: Bearer $TOKEN2" $B/auth/me)"

echo "── Authenticated routes ─────────────────────────────────────────────────"
chk "no token -> 401" 401 "$(code $B/auth/me)"
chk "garbage token -> 401" 401 "$(code -H "Authorization: Bearer nonsense" $B/auth/me)"
chk "malformed header -> 401" 401 "$(code -H "Authorization: $TOKEN2" $B/auth/me)"
chk "GET /profile -> 200" 200 "$(code -H "Authorization: Bearer $TOKEN2" $B/profile)"
echo "     $(body)"

echo "── Profile update ───────────────────────────────────────────────────────"
chk "update names -> 200" 200 "$(code -X PUT -H "$J" -H "Authorization: Bearer $TOKEN2" -d '{"firstName":"Marianne","lastName":"Watson"}' $B/profile)"
chk "login ID/email ignored" 200 "$(code -X PUT -H "$J" -H "Authorization: Bearer $TOKEN2" -d '{"loginId":"hacked","email":"hacked@evil.com","firstName":"Marianne"}' $B/profile)"
echo "     after attempted identity change: $(body | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).user;console.log('loginId='+u.loginId+' email='+u.email)})")"
chk "invalid name rejected -> 400" 400 "$(code -X PUT -H "$J" -H "Authorization: Bearer $TOKEN2" -d '{"firstName":"X"}' $B/profile)"

echo "── Administrator login ──────────────────────────────────────────────────"
chk "admin wrong password -> 401" 401 "$(code -X POST -H "$J" -d '{"loginId":"admin","password":"nope","isAdmin":true}' $B/auth/login)"
chk "admin valid -> 200" 200 "$(code -X POST -H "$J" -d '{"loginId":"admin","password":"ScaAdmin@dt8624","isAdmin":true}' $B/auth/login)"
ATOKEN=$(body | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
chk "admin /auth/me -> 200" 200 "$(code -H "Authorization: Bearer $ATOKEN" $B/auth/me)"
echo "     $(body)"
chk "admin cannot delete account -> 403" 403 "$(code -X DELETE -H "Authorization: Bearer $ATOKEN" $B/auth/account)"
chk "admin cannot edit profile -> 403" 403 "$(code -X PUT -H "$J" -H "Authorization: Bearer $ATOKEN" -d '{"firstName":"Root"}' $B/profile)"
chk "user login unaffected by admin session" 200 "$(code -H "Authorization: Bearer $TOKEN2" $B/auth/me)"

echo "── Logout and deletion ──────────────────────────────────────────────────"
chk "logout -> 200" 200 "$(code -X POST -H "Authorization: Bearer $TOKEN2" $B/auth/logout)"
chk "token rejected after logout -> 401" 401 "$(code -H "Authorization: Bearer $TOKEN2" $B/auth/me)"
chk "login again after logout -> 200" 200 "$(code -X POST -H "$J" -d '{"loginId":"alice","password":"password123"}' $B/auth/login)"
TOKEN3=$(body | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
chk "delete account -> 200" 200 "$(code -X DELETE -H "Authorization: Bearer $TOKEN3" $B/auth/account)"
chk "token dead after deletion -> 401" 401 "$(code -H "Authorization: Bearer $TOKEN3" $B/auth/me)"
chk "cannot log in after deletion -> 401" 401 "$(code -X POST -H "$J" -d '{"loginId":"alice","password":"password123"}' $B/auth/login)"
chk "login ID freed for reuse -> 201" 201 "$(code -X POST -H "$J" -d '{"firstName":"Fresh","lastName":"Start","loginId":"alice","password":"password123"}' $B/auth/register)"

echo "── Brute-force lockout ──────────────────────────────────────────────────"
for i in 1 2 3 4 5; do code -X POST -H "$J" -d '{"loginId":"bob","password":"wrongpass'"$i"'"}' $B/auth/login >/dev/null; done
chk "6th attempt -> 429 locked out" 429 "$(code -X POST -H "$J" -d '{"loginId":"bob","password":"wrongpassX"}' $B/auth/login)"
echo "     $(body)"
chk "CORRECT password also locked -> 429" 429 "$(code -X POST -H "$J" -d '{"loginId":"bob","password":"password123"}' $B/auth/login)"
chk "different user unaffected -> 200" 200 "$(code -X POST -H "$J" -d '{"loginId":"jose","password":"password123"}' $B/auth/login)"

echo ""
echo "════ $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
