# Security

ICS Calendar Viewer is intentionally local and read-only.

- No network calls or remote calendar fetching.
- No CalDAV, URL import, sync, RSVP, email, notification, or clipboard integration.
- No `.ics` write-back, vault note generation, daily note import, or file modification.
- No `eval`, `new Function`, or process APIs in plugin runtime code.
- Rendering is DOM text-based; parsed ICS values are inserted with text APIs rather than HTML injection.

Calendar files often contain private locations, attendees, descriptions, and identifiers. Treat fixtures and bug reports as sensitive unless they are explicitly scrubbed.
