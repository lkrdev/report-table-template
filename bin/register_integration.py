#!/usr/bin/env uv run
# /// script
# dependencies = [
#     "looker-sdk>=24.0.0",
# ]
# ///

import hashlib
import hmac
import os
import secrets
import time

# Fallback for local IDE autocomplete and static analysis
if "sdk" not in globals():
    import looker_sdk
    sdk = looker_sdk.init40()

url = os.environ.get('SERVICE_URL')
token = os.environ.get('API_KEY_TOKEN')

if not url:
    raise Exception("SERVICE_URL environment variable not set.")
if not token:
    raise Exception("API_KEY_TOKEN environment variable not set.")

# If the token is a raw secret key (i.e. does not contain a '/'),
# dynamically generate the required nonce/digest token format.
if "/" not in token:
    nonce = secrets.token_bytes(32).hex()
    digest = hmac.new(
        token.encode("utf-8"),
        nonce.encode("utf-8"),
        hashlib.sha512
    ).hexdigest()
    token = f"{nonce}/{digest}"

print(f'Registering Integration Hub {url} in Looker...')
try:
    new_hub = sdk.create_integration_hub(
        body={
            'url': url,
            'authorization_token': token
        }
    )
    print(f'Successfully registered Integration Hub (ID: {new_hub.id})')
except Exception as e:
    hubs = sdk.all_integration_hubs()
    new_hub = next((h for h in hubs if h.url == url), None)
    if not new_hub:
        raise Exception(f'Failed to find or create the Integration Hub: {e}')
    sdk.update_integration_hub(
        integration_hub_id=new_hub.id,
        body={
            'url': url,
            'authorization_token': token
        }
    )
    print(f'Updated existing Integration Hub (ID: {new_hub.id})')

print('Enabling google_docs integration...')
integration = None
for attempt in range(6):
    integrations = sdk.all_integrations()
    integration = next((i for i in integrations if i.integration_hub_id == new_hub.id and i.id.split("::")[-1] == "google_docs"), None)
    if integration:
        break
    if attempt < 5:
        print(f"Integration 'google_docs' not found on hub {new_hub.id} yet. Retrying in 3 seconds... (Attempt {attempt+1}/6)")
        time.sleep(3)

if integration:
    sdk.update_integration(
        integration_id=integration.id,
        body={'enabled': True}
    )
    print('Successfully enabled google_docs integration!')
else:
    raise Exception('Could not find google_docs integration on the registered hub.')
