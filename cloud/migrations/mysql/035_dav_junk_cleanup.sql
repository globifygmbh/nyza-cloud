-- WebDAV/Finder/Explorer sidecar files (.DS_Store, AppleDouble ._*, Thumbs.db,
-- desktop.ini, …) that were silently uploaded before the DAV junk guard existed.
-- Soft-delete them so they vanish from every listing; emptying the trash later
-- reclaims their (tiny) quota through the normal path.
UPDATE files
SET deleted_at = CURRENT_TIMESTAMP
WHERE deleted_at IS NULL
  AND (
        name LIKE '._%'
     OR LOWER(name) IN (
          '.ds_store', '.localized', '.apdisk',
          'thumbs.db', 'desktop.ini', 'ehthumbs.db',
          '.volumeicon.icns'
        )
  );
