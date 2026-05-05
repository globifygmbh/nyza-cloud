<?php
/**
 * Standalone setup wizard entry. Use when:
 *  - the .htaccess rewrite isn't working (so /cloud/?setup=1 won't reach index.php),
 *  - or you want a stable bookmarkable URL for diagnostics: /cloud/setup.php
 */
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';
(new \Nyza\SetupWizard(__DIR__))->handle();
