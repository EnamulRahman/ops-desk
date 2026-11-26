// Reference solutions: one per ticket. Strings are shell lines; {edit, fn} opens an editor and saves fn(text).
const Y = (o) => o;
module.exports = {
  "PW-101": ["df -h", "sudo du -sh /var/log/*", "sudo rm /var/log/parcelwise/app.log.*", "df -h", "curl -s localhost/health"],
  "PW-102": ["sudo nginx -t", { edit: "sudo nano /etc/nginx/sites-enabled/parcelwise", fn: (t) => t.replace("proxy_pass http://127.0.0.1:8080\n", "proxy_pass http://127.0.0.1:8080;\n") }, "sudo nginx -t", "sudo systemctl restart nginx", "curl -I localhost"],
  "PW-103": ["sudo useradd -m -s /bin/bash -G deploy jlee", "id jlee"],
  "PW-104": ["cat /var/log/db-backup.log", "ls -l /opt/scripts", "sudo chmod 755 /opt/scripts/db-backup.sh", "sudo /opt/scripts/db-backup.sh"],
  "PW-105": ["ps aux", "kill 31877", "kill -9 31877"],
  "PW-201": ["docker ps -a", "docker logs tracking-api", "docker rm tracking-api", "docker run -d --name tracking-api -p 8080:8080 --env-file ~/tracking-api.env --restart unless-stopped parcelwise/tracking-api:1.8.0", "curl localhost:8080/health"],
  "PW-202": ["docker ps", "docker rm -f label-ui", "docker run -d --name label-ui -p 80:8080 --restart unless-stopped parcelwise/label-ui:2.1.0", "curl -s localhost"],
  "PW-203": [{ edit: "nano ~/parcel-web/Dockerfile", fn: () => "FROM node:22 AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci\nRUN npm run build\n\nFROM node:22-alpine\nWORKDIR /app\nCOPY --from=build /app/dist ./dist\nCOPY package*.json ./\nRUN npm ci --omit=dev\nUSER node\nCMD [\"node\", \"dist/server.js\"]\n" }, "docker build -t parcel-web:2.0 ~/parcel-web", "docker images"],
  "PW-204": ["docker system df", "docker system prune -a -f", "df -h", "docker ps"],
  "PW-301": ["kubectl get pods", "kubectl set image deploy/checkout-api checkout-api=parcelwise/checkout-api:3.2.0", "kubectl rollout status deploy/checkout-api", "curl http://shop.parcelwise.test/checkout"],
  "PW-302": ["kubectl get endpoints tracking-api", { edit: "kubectl edit svc tracking-api", fn: (t) => t.replace("app: tracking\n", "app: tracking-api\n") }, "curl http://shop.parcelwise.test/track"],
  "PW-303": ["kubectl get pods", { edit: "kubectl edit deploy notify", fn: (t, y) => { const o = y.load(t); o.spec.template.spec.containers[0].envFrom = [{ configMapRef: { name: "notify-config" } }]; return y.dump(o); } }, "kubectl get pods"],
  "PW-304": [{ edit: "kubectl edit deploy label-renderer", fn: (t, y) => { const o = y.load(t); o.spec.template.spec.containers[0].resources = { requests: { cpu: "100m", memory: "384Mi" }, limits: { memory: "512Mi" } }; return y.dump(o); } }, "kubectl get pods"],
  "PW-305": ["kubectl rollout history deploy/payments-api", "kubectl rollout undo deploy/payments-api", "kubectl rollout status deploy/payments-api", "curl http://shop.parcelwise.test/pay"],
  "PW-306": [{ edit: "kubectl edit deploy search-api", fn: (t, y) => { const o = y.load(t); o.spec.template.spec.containers[0].readinessProbe.httpGet.path = "/healthz"; return y.dump(o); } }, "kubectl get pods"],
  "PW-401": ["kubectl get ingress", "kubectl get ingressclass", { edit: "kubectl edit ingress status-page", fn: (t) => t.replace("nginx-public", "nginx") }, "curl http://status.parcelwise.test"],
  "PW-402": ["kubectl get cm checkout-config -o yaml", "kubectl create secret generic checkout-db --from-literal=DB_PASSWORD='Pw-Ch3ck0ut!-2026'",
    { edit: "kubectl edit deploy checkout-api", fn: (t, y) => { const o = y.load(t); o.spec.template.spec.containers[0].env = [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "checkout-db", key: "DB_PASSWORD" } } }]; return y.dump(o); } },
    { edit: "kubectl edit cm checkout-config", fn: (t, y) => { const o = y.load(t); delete o.data.DB_PASSWORD; return y.dump(o); } }, "kubectl rollout restart deploy/checkout-api", "curl http://shop.parcelwise.test/checkout"],
  "PW-403": ["kubectl top pods", "kubectl autoscale deploy storefront --min=3 --max=10 --cpu-percent=60", "kubectl get hpa", "kubectl top pods"],
};
