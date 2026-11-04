# Prints the clipboard's files as "file<TAB>path", or saves its image to $Out and
# prints "image<TAB>path". Run with -File so $Out is never parsed as code.
param([Parameter(Mandatory)][string]$Out)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$files = [Windows.Forms.Clipboard]::GetFileDropList()
if ($files.Count) {
  $files | ForEach-Object { "file`t$_" }
  exit
}

# The PNG format keeps transparency, which GetImage() loses.
$data = [Windows.Forms.Clipboard]::GetDataObject()
if ($data -and $data.GetDataPresent('PNG')) {
  $file = $null
  try {
    $stream = $data.GetData('PNG')
    $file = [IO.File]::Create($Out)
    $stream.CopyTo($file)
    $file.Close()
    "image`t$Out"
    exit
  } catch {
    if ($file) { $file.Close() }
  }
}

$image = [Windows.Forms.Clipboard]::GetImage()
if ($image) {
  $image.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
  "image`t$Out"
}
