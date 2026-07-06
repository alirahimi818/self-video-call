#!/bin/sh
set -eu

: "${TURN_SECOND_IP:?TURN_SECOND_IP env var is required}"
: "${TURN_SHARED_SECRET:?TURN_SHARED_SECRET env var is required}"
: "${TURN_REALM:?TURN_REALM env var is required}"
: "${TURN_MIN_PORT:=49160}"
: "${TURN_MAX_PORT:=49200}"

export TURN_SECOND_IP TURN_SHARED_SECRET TURN_REALM TURN_MIN_PORT TURN_MAX_PORT

envsubst < /etc/coturn/turnserver.conf.template > /etc/coturn/turnserver.conf

exec turnserver -c /etc/coturn/turnserver.conf
