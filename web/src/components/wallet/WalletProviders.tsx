import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { useDevnet } from '@/lib/chain';
import { WalletModalProvider } from './WalletModal';

/**
 * Connection and wallet context for the whole app.
 *
 * `wallets={[]}` is not a mistake: every current Solana wallet registers
 * itself through the Wallet Standard, and the adapter picks those up on its
 * own. Listing specific adapters here would only add bundle weight and a
 * fixed list that goes stale.
 *
 * The RPC comes from the devnet manifest so the site and the vault it shows
 * agree on a cluster. With no manifest (no deployment) the public devnet
 * endpoint is used and nothing on-chain is shown anyway.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const devnet = useDevnet();
  const endpoint = useMemo(
    () => devnet?.rpc ?? 'https://api.devnet.solana.com',
    [devnet?.rpc],
  );

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
