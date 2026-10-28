param(
    [switch]$ListVoices,
    [string]$TextPath,
    [string]$OutputPath,
    [string]$Voice = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($ListVoices) {
        $voices = @($speaker.GetInstalledVoices() |
            Where-Object { $_.Enabled } |
            ForEach-Object {
                @{ id = $_.VoiceInfo.Name; label = "$($_.VoiceInfo.Name) ($($_.VoiceInfo.Culture.Name))" }
            })
        ConvertTo-Json -InputObject $voices -Compress
    } else {
        if (!$TextPath -or !$OutputPath) { throw "TextPath and OutputPath are required." }
        if ($Voice) { $speaker.SelectVoice($Voice) }
        $text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
        $speaker.SetOutputToWaveFile($OutputPath)
        $speaker.Speak($text)
    }
} finally {
    $speaker.Dispose()
}
