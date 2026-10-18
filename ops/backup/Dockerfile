# Nightly encrypted backups: pg_dump + media snapshot + manifest, encrypted with age to a
# public key. The server cannot decrypt its own backups; the private key stays with custodians.
FROM postgres:17.11-alpine
RUN apk add --no-cache age tar coreutils tzdata
COPY backup.sh restore.sh run.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/run.sh \
    && sed -i 's/\r$//' /usr/local/bin/*.sh
USER postgres
CMD ["/usr/local/bin/run.sh"]
