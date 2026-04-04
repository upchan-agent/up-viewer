// Convert IPFS URL to gateway URL
// Handles: ipfs://CID, ipfs.io/ipfs/CID, QmCID..., bafk... (CIDv0/v1 direct)
export const toGatewayUrl = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  const gateway = 'https://api.universalprofile.cloud/ipfs/';
  
  if (url.startsWith('ipfs://')) {
    return `${gateway}${url.replace('ipfs://', '')}`;
  }
  if (url.startsWith('https://ipfs.io/ipfs/')) {
    return `${gateway}${url.replace('https://ipfs.io/ipfs/', '')}`;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url; // other HTTP URLs are passed through
  }
  // CID direct (Qm... or bafk...)
  if (url.startsWith('Qm') || url.startsWith('baf')) {
    return `${gateway}${url}`;
  }
  return url;
};

// Shorten address for display
export const shortenAddress = (addr: string, chars = 4): string => {
  if (!addr) return '';
  if (addr.length < chars * 2 + 2) return addr;
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
};