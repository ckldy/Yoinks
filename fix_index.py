import re

with open('/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yoinks/index.tsx', 'r') as f:
    content = f.read()

# Fix line 281 - the unclosed fragment
content = content.replace(
    '{debugMode ? <>',
    '{debugMode ? <>'
)

# Find the three external view functions
settings_start = content.find('function SettingsView() {')
history_start = content.find('function HistoryView() {')
download_start = content.find('function DownloadView() {')
view_func_start = content.find('function View() {')

print(f"SettingsView at: {settings_start}")
print(f"HistoryView at: {history_start}")
print(f"DownloadView at: {download_start}")
print(f"View() at: {view_func_start}")

# Extract the three view functions
settings_end = history_start
history_end = download_start
download_end = view_func_start

print(f"SettingsView: {settings_start}-{settings_end}")
print(f"HistoryView: {history_start}-{history_end}")
print(f"DownloadView: {download_start}-{download_end}")

settings_view = content[settings_start:settings_end].rstrip()
history_view = content[history_start:history_end].rstrip()
download_view = content[download_start:download_end].rstrip()

# Remove the three functions from their current location
new_content = content[:settings_start] + content[download_end:]

# Find where to insert them inside View() - just before the return statement
return_pos = new_content.find('return (', view_func_start)
if return_pos == -1:
    print("Return not found!")
    exit(1)

print(f"Insert at: {return_pos}")

# Insert before return
insert_pos = return_pos
insertion = "\n\n" + settings_view + "\n\n" + history_view + "\n\n" + download_view + "\n\n"
new_content = new_content[:insert_pos] + insertion + new_content[insert_pos:]

# Write back
with open('/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yoinks/index.tsx', 'w') as f:
    f.write(new_content)

print("Done!")