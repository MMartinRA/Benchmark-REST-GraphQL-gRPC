#!/usr/bin/env bash
# Uso normal (recomendado):  ./deploy.sh
#   -> lee las IPs y la clave directamente de "terraform output" en infra/
# Uso manual (si hace falta): ./deploy.sh <ip_rest> <ip_graphql> <ip_grpc> <ruta_clave_privada>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/infra"
REMOTE_DIR="/home/ubuntu/stack"

if [ "$#" -eq 4 ]; then
  REST_IP=$1
  GRAPHQL_IP=$2
  GRPC_IP=$3
  KEY=$4
elif [ "$#" -eq 0 ]; then
  echo ">>> No me pasaste IPs a mano, las leo de 'terraform output' en infra/"
  if [ ! -f "$INFRA_DIR/terraform.tfstate" ]; then
    echo "No encuentro $INFRA_DIR/terraform.tfstate. ¿Ya corriste 'terraform apply' dentro de infra/?"
    exit 1
  fi
  REST_IP=$(cd "$INFRA_DIR" && terraform output -raw rest_ip)
  GRAPHQL_IP=$(cd "$INFRA_DIR" && terraform output -raw graphql_ip)
  GRPC_IP=$(cd "$INFRA_DIR" && terraform output -raw grpc_ip)
  KEY_NAME=$(cd "$INFRA_DIR" && terraform output -raw ssh_key_path | xargs basename)
  KEY="$INFRA_DIR/$KEY_NAME"
else
  echo "Uso: $0                                          (lee todo de terraform output)"
  echo "  o: $0 <ip_rest> <ip_graphql> <ip_grpc> <ruta_clave_privada>"
  exit 1
fi

echo ">>> IPs detectadas:"
echo "    REST:    $REST_IP"
echo "    GraphQL: $GRAPHQL_IP"
echo "    gRPC:    $GRPC_IP"
echo "    Clave:   $KEY"
echo ""

if [ ! -f "$KEY" ]; then
  echo "No encuentro la clave privada en $KEY"
  exit 1
fi
chmod 400 "$KEY" 2>/dev/null || true

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$KEY")

wait_for_ssh() {
  local ip=$1
  echo ">>> Esperando que $ip acepte SSH (puede tardar ~1 min tras el apply)..."
  for i in $(seq 1 30); do
    if ssh "${SSH_OPTS[@]}" "ubuntu@$ip" "echo listo" >/dev/null 2>&1; then
      echo "    $ip listo."
      return 0
    fi
    sleep 5
  done
  echo "No se pudo conectar a $ip por SSH tras 2.5 minutos de reintentos."
  exit 1
}

deploy_stack() {
  local ip=$1
  local local_dir=$2

  wait_for_ssh "$ip"

  echo ">>> Copiando $(basename "$local_dir") a ubuntu@$ip:$REMOTE_DIR"
  ssh "${SSH_OPTS[@]}" "ubuntu@$ip" "mkdir -p $REMOTE_DIR"
  scp -o StrictHostKeyChecking=no -i "$KEY" -r "$local_dir"/* "ubuntu@$ip:$REMOTE_DIR/" >/dev/null

  echo ">>> Levantando el stack en $ip (puede tardar varios minutos la primera vez, construye 3 imágenes)"
  ssh "${SSH_OPTS[@]}" "ubuntu@$ip" "cd $REMOTE_DIR && sudo docker compose up -d --build"

  echo ">>> Listo: $ip"
  echo ""
}

deploy_stack "$REST_IP" "$SCRIPT_DIR/cloud/rest-stack"
deploy_stack "$GRAPHQL_IP" "$SCRIPT_DIR/cloud/graphql-stack"
deploy_stack "$GRPC_IP" "$SCRIPT_DIR/cloud/grpc-stack"

# Genera targets.json automáticamente, así no hay que editarlo a mano
TARGETS_FILE="$SCRIPT_DIR/load-tester/targets.json"
cat > "$TARGETS_FILE" <<JSON
{
  "rest": { "ip": "$REST_IP" },
  "graphql": { "ip": "$GRAPHQL_IP" },
  "grpc": { "ip": "$GRPC_IP" }
}
JSON
echo ">>> Generé $TARGETS_FILE automáticamente con las 3 IPs."
echo ""
echo "Los tres stacks están desplegados. Probalos con:"
echo "  curl http://$REST_IP:3000/health"
echo "  curl -X POST http://$GRAPHQL_IP:4000 -H 'content-type: application/json' -d '{\"query\":\"{__typename}\"}'"
echo "  curl http://$GRPC_IP:9100/health"
