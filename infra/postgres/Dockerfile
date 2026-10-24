# Keep the existing Postgres major version and Alpine data-volume environment.
FROM postgres:17-alpine AS extension
ARG PGVECTOR_VERSION=0.8.7
RUN apk add --no-cache build-base curl \
    && curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" -o /tmp/vector.tar.gz \
    && tar -xzf /tmp/vector.tar.gz -C /tmp \
    && cd "/tmp/pgvector-${PGVECTOR_VERSION}" \
    && make OPTFLAGS="" with_llvm=no \
    && make install DESTDIR=/opt/vector with_llvm=no
FROM postgres:17-alpine
COPY --from=extension /opt/vector/usr/local/ /usr/local/
