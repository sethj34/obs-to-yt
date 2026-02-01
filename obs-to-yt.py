'''
auto-uploads new files in obs output directory to youtube VIA youtube api
'''

import os
import time
import pickle
from pathlib import Path
from datetime import datetime

from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from googleapiclient.errors import HttpError
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request


OUTPUT_PATH = Path(r'L:\OBS Outputs')
CLIENT_SECRETS_FILE = 'client_secrets.json'
TOKEN_CACHE_FILE = 'token.pickle'

POLL_SECONDS = 10
UPLOAD_PRIVACY = 'unlisted'
UPLOAD_DESCRIPTION = ''
UPLOAD_CATEGORY_ID = '22'

STABILITY_CHECKS = 3
STABILITY_INTERVAL = 2

REMUX_GRACE_SECONDS = 180
REMUX_POLL_INTERVAL = 2

SCOPES = ['https://www.googleapis.com/auth/youtube.upload']


def get_authenticated_service(client_secrets_file: str, token_cache: str):
    creds = None

    if os.path.exists(token_cache):
        with open(token_cache, 'rb') as f:
            creds = pickle.load(f)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(client_secrets_file, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_cache, 'wb') as f:
            pickle.dump(creds, f)

    return build('youtube', 'v3', credentials=creds)


def make_title():
    # DDMMYYYYHHMM -> ex: 300120261601
    return input('title: ')


def wait_until_file_stable(path: Path, checks: int, interval: int):
    last_size = -1
    stable_count = 0

    while stable_count < checks:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            size = -1

        if size == last_size and size > 0:
            stable_count += 1
        else:
            stable_count = 0
            last_size = size

        time.sleep(interval)


def find_remuxed_mp4(mkv_path: Path) -> Path | None:
    target_mp4 = mkv_path.with_suffix('.mp4')
    deadline = time.time() + REMUX_GRACE_SECONDS

    while time.time() < deadline:
        if target_mp4.exists():
            wait_until_file_stable(target_mp4, STABILITY_CHECKS, STABILITY_INTERVAL)
            return target_mp4

        time.sleep(REMUX_POLL_INTERVAL)

    return None


def upload_to_youtube(youtube, video_file: Path, title: str, description: str, privacy: str):
    body = {
        'snippet': {
            'title': title,
            'description': description,
            'categoryId': UPLOAD_CATEGORY_ID,
        },
        'status': {
            'privacyStatus': privacy,
            'selfDeclaredMadeForKids': False,
        },
    }

    media = MediaFileUpload(str(video_file), resumable=True)

    request = youtube.videos().insert(
        part='snippet,status',
        body=body,
        media_body=media,
    )

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f'Upload progress: {int(status.progress() * 100)}%')

    return response


def main():
    if not OUTPUT_PATH.exists():
        raise FileNotFoundError(f'OUTPUT_PATH does not exist: {OUTPUT_PATH}')

    print('Authenticating with YouTube...')
    youtube = get_authenticated_service(CLIENT_SECRETS_FILE, TOKEN_CACHE_FILE)
    print('Authenticated.\n')

    seen = set(p.name for p in OUTPUT_PATH.glob('*') if p.suffix.lower() in {'.mp4', '.mkv'})
    print(f'Watching folder: {OUTPUT_PATH}')
    print(f'Initial recordings count (.mp4/.mkv): {len(seen)}')
    print('Waiting for new recordings...\n')

    while True:
        try:
            current_paths = [p for p in OUTPUT_PATH.glob('*') if p.suffix.lower() in {'.mp4', '.mkv'}]
            current = set(p.name for p in current_paths)
            new_files = current - seen

            for filename in sorted(new_files):
                path = OUTPUT_PATH / filename
                ext = path.suffix.lower()

                print(f'Detected new file: {path}')
                print('Waiting for file to finish writing...')
                wait_until_file_stable(path, STABILITY_CHECKS, STABILITY_INTERVAL)

                upload_path = path

                if ext == '.mkv':
                    print(f'MKV detected. Waiting up to {REMUX_GRACE_SECONDS}s for remuxed MP4...')
                    mp4 = find_remuxed_mp4(path)
                    if mp4 is not None:
                        print(f'Found remuxed MP4: {mp4} (will upload this instead of MKV)')
                        upload_path = mp4
                    else:
                        print('No remuxed MP4 found in grace window; uploading MKV.')

                title = make_title()
                print(f'Uploading: {upload_path}')
                print(f'Title: {title}')

                try:
                    result = upload_to_youtube(
                        youtube,
                        video_file=upload_path,
                        title=title,
                        description=UPLOAD_DESCRIPTION,
                        privacy=UPLOAD_PRIVACY,
                    )
                    print(f'Upload complete! Video ID: {result.get('id')}\n')

                    seen.add(filename)
                    seen.add(upload_path.name)

                    seen.add(path.with_suffix('.mp4').name)
                    seen.add(path.with_suffix('.mkv').name)

                except HttpError as e:
                    print('YouTube upload failed (HttpError):')
                    print(e)
                    print('Will NOT mark as seen; will retry next scan.\n')

            time.sleep(POLL_SECONDS)

        except KeyboardInterrupt:
            print('\nStopping watcher. Bye!')
            break

        except Exception as e:
            print('Unexpected error:', e)
            print('Retrying in 10 seconds...\n')
            time.sleep(10)


if __name__ == '__main__':
    main()