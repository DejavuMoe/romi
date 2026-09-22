# Build context contains only the verified static musl Agent binary.
FROM scratch
ARG VERSION
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/DejavuMoe/romi" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"
COPY --chmod=0555 romi-agent /romi-agent
USER 65534:65534
ENTRYPOINT ["/romi-agent"]
