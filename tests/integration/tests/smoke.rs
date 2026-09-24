//! Does LiteSVM run on this machine at all? (The CPU has no AVX2, which is why
//! solana-test-validator cannot.) Loads Pyth's verifier and a trivial transfer.

use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn litesvm_runs_and_loads_pyths_verifier() {
    let mut svm = LiteSVM::new();
    let lazer: solana_address::Address = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt".parse().unwrap();
    svm.add_program_from_file(lazer, "fixtures/pyth_lazer.so").expect("run ./fetch.sh first");
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap();
    assert_eq!(svm.get_balance(&kp.pubkey()), Some(1_000_000_000));
    println!("ok litesvm on this cpu; lazer loaded");
}
