### Fixed
- Status and conversation process-metadata probes run asynchronously with bounded child processes and waiting, so slow macOS probes do not block the Web UI event loop. Pending-input identity checks retain their synchronous behavior.
