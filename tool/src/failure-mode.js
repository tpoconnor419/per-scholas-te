// Just paste this into a PowerShell prompt to set the failure mode of the mock platform. This is useful for testing error handling in the tool.
function Set-FailureMode([ValidateSet('off','error','ratelimit','slow')]$Mode) {
  Invoke-RestMethod -Uri http://localhost:4000/admin/failure-mode -Method Post `
    -ContentType 'application/json' -Body (@{ mode = $Mode } | ConvertTo-Json)
}
