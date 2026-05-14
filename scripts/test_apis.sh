#!/bin/bash
echo "=== 1. Auth Status ==="
curl -sk -o /dev/null -w 'HTTP %{http_code}\n' https://linyeaiyrs.top/api/auth/status

echo ""
echo "=== 2. Login ==="
RESP=$(curl -sk -X POST https://linyeaiyrs.top/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"linye","password":"12345678"}')
echo "$RESP" | head -c 200
echo ""

TOKEN=$(echo "$RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("access_token",""))')
echo ""
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== 3. Identify History ==="
curl -sk https://linyeaiyrs.top/api/identify/history \
  -H "Authorization: Bearer $TOKEN" \
  -w '\nHTTP %{http_code}\n' | head -c 300

echo ""
echo ""
echo "=== 4. Q&A (LLM test) ==="
curl -sk -X POST https://linyeaiyrs.top/api/qa/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"question":"1+1=?","contexts":[]}' \
  -w '\nHTTP %{http_code}\n' --max-time 15 | head -c 300

echo ""
echo ""
echo "=== ALL TESTS DONE ==="
