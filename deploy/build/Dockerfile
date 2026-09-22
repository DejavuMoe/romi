ARG BUILD_IMAGE
FROM ${BUILD_IMAGE}
ARG LIBC
RUN if [ "$LIBC" = musl ]; then \
      apk add --no-cache build-base linux-headers python3 curl openssl openrc binutils; \
    else \
      apt-get update && apt-get install -y --no-install-recommends g++ make python3 curl openssl binutils \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /workspace
