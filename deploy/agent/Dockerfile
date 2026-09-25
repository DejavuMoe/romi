# Build context: the verified static musl Agent binary and the license files
# its distribution requires.
FROM scratch
ARG VERSION
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/DejavuMoe/romi" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="MIT"
COPY --chmod=0555 romi-agent /romi-agent
COPY --chmod=0444 LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt /licenses/
USER 65534:65534
ENTRYPOINT ["/romi-agent"]
