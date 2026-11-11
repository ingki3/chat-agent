Test-only self-signed certificate (CN public.test, SAN DNS:public.test and IP:93.184.216.34, valid 100 years)
for the web fetch HTTPS tests (#50). The key protects nothing; it is trusted only by the in-process test worker.
Regenerate:
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout test-only.key -out test-only.crt \
  -days 36500 -subj "/CN=public.test" -addext "subjectAltName=DNS:public.test,IP:93.184.216.34"
