-- Remove the account `url` (website) column. It had no remaining consumer: attribution freezes the
-- verified publisher domain (not the account website), and nothing rendered it beyond the settings
-- edit form. No view/index/trigger references it, so a plain DROP COLUMN is safe.
ALTER TABLE account DROP COLUMN url;
