-- Per-folder opt-in: OCR-rename uploaded receipts to
-- "YYYY-MM-DD_Vendor_amount.ext". Off by default; enable on a "Belege" folder.
ALTER TABLE folders ADD COLUMN auto_rename TINYINT(1) NOT NULL DEFAULT 0;
