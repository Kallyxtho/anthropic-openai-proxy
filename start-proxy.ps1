$listening = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }
Start-Process -FilePath "node.exe" `
  -ArgumentList "./proxy.js" `
  -WorkingDirectory "." `
  -WindowStyle Hidden `
  -RedirectStandardOutput "./proxy.log" `
  -RedirectStandardError "./proxy-err.log"
