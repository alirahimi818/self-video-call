FROM coturn/coturn:4.6-alpine

USER root
RUN apk add --no-cache gettext

COPY turnserver.conf.template /etc/coturn/turnserver.conf.template
COPY entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
