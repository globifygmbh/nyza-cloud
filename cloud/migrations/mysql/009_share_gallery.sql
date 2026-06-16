-- Nyza Cloud · 009 · Galerie-Modus für geteilte Ordner
-- Optionaler „schöne Galerie"-Modus pro Share-Link (Bilder im Originalformat,
-- Masonry-Ansicht, Ordnername als Galerie-Titel). Nur ein Anzeige-Flag.
ALTER TABLE share_links ADD COLUMN gallery TINYINT(1) NOT NULL DEFAULT 0;
