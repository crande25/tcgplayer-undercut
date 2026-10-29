# Rebuilds install.html (the bookmarklet install page) from tcg-undercut.js and install.template.html.
# Run after editing either file:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false

$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'tcg-undercut.js'), $utf8)
$version = [regex]::Match($source, "const VERSION = '([^']+)'").Groups[1].Value
if (-not $version) { throw 'tcg-undercut.js has no VERSION constant.' }

# Percent-encoding keeps the bookmarklet on one line and safe inside an HTML attribute.
$bookmarklet = 'javascript:' + [Uri]::EscapeDataString($source)
if ([Uri]::UnescapeDataString($bookmarklet.Substring('javascript:'.Length)) -cne $source) {
  throw 'The encoded bookmarklet does not decode back to tcg-undercut.js.'
}

$template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install.template.html'), $utf8)
foreach ($placeholder in '{{BOOKMARKLET}}', '{{VERSION}}') {
  if (-not $template.Contains($placeholder)) { throw "install.template.html has no $placeholder placeholder." }
}
$page = $template.Replace('{{BOOKMARKLET}}', $bookmarklet).Replace('{{VERSION}}', $version)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'install.html'), $page, $utf8)

'Wrote install.html for version {0} (bookmarklet is {1:N0} characters).' -f $version, $bookmarklet.Length
