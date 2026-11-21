# Daybook (journal app)

An installable Home Screen web app for logging what you did each day. No build step: serve this folder as a static site over HTTPS, open it in Safari on iPhone, then Share > Add to Home Screen.

- Entries and photos are stored on the phone (IndexedDB) and work offline.
- More > Export everything gives a .zip laid out like the project journal (`journal/YYYY-MM-DD.md` + `journal/media/YYYY-MM-DD/`).
- More > Import accepts those .md pages or a .zip of them, merging without duplicates.
