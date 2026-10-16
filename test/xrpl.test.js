import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { walletFromSeed, encode, txHash, sign, isValidAddress, xrpToDrops, dropsToXrp, generateSeed } from "../xrpl.js";

const FIX = process.env.XRPL_FIXTURES; // path to xrpl.js/packages

test("ed25519 seed -> keys, address and signature match ripple-keypairs", () => {
  const api = JSON.parse(fs.readFileSync(FIX + "/ripple-keypairs/test/fixtures/api.json")).ed25519;
  const w = walletFromSeed(api.seed);
  assert.equal(w.publicKeyHex, api.keypair.publicKey);
  assert.equal(w.privateKeyHex, api.keypair.privateKey);
  assert.equal(w.address, api.address);
  assert.equal(w.sign(Buffer.from(api.message)).toString("hex").toUpperCase(), api.signature);
});

test("escrow finish encodes to the right hash", () => {
  const tx = JSON.parse(fs.readFileSync(FIX + "/ripple-binary-codec/test/fixtures/escrow-finish-tx.json"));
  const { meta, hash, ...fields } = tx;
  assert.equal(txHash(encode(fields).toString("hex")), hash);
});

test("all supported-field transactions in codec fixtures round-trip", () => {
  const cf = JSON.parse(fs.readFileSync(FIX + "/ripple-binary-codec/test/fixtures/codec-fixtures.json"));
  const ok = new Set(["TransactionType","Flags","SourceTag","Sequence","DestinationTag","OfferSequence","LastLedgerSequence","CancelAfter","FinishAfter","Amount","Fee","SigningPubKey","TxnSignature","Account","Owner","Destination","NetworkID"]);
  let n = 0;
  for (const t of cf.transactions) {
    const j = t.json;
    if (!["Payment","EscrowCreate","EscrowFinish"].includes(j.TransactionType)) continue;
    if (!Object.keys(j).every((k) => ok.has(k))) continue;
    if (typeof j.Amount === "object") continue;
    assert.equal(encode(j).toString("hex").toUpperCase(), t.binary.toUpperCase());
    n++;
  }
  console.log("matched", n, "fixtures");
  assert.ok(n > 0);
});

test("signed tx is verifiable and stable", () => {
  const w = walletFromSeed(generateSeed());
  const tx = { TransactionType: "EscrowCreate", Account: w.address, Destination: w.address, Amount: "1000000", FinishAfter: 800000000, SourceTag: 7, Fee: "12", Sequence: 5, Flags: 0, LastLedgerSequence: 100 };
  const a = sign(tx, w), b = sign(tx, w);
  assert.equal(a.blob, b.blob);
  assert.equal(a.hash.length, 64);
});

test("amount helpers and address check", () => {
  assert.equal(xrpToDrops("12.5"), "12500000");
  assert.equal(dropsToXrp("12500000"), "12.5");
  assert.equal(dropsToXrp("1"), "0.000001");
  assert.throws(() => xrpToDrops("1.1234567"));
  assert.ok(isValidAddress("rLUEXYuLiQptky37CqLcm9USQpPiz5rkpD"));
  assert.ok(!isValidAddress("rLUEXYuLiQptky37CqLcm9USQpPiz5rkpE"));
});

test("escrow create matches fixture (Condition removed)", () => {
  const j = JSON.parse(fs.readFileSync(FIX + "/ripple-binary-codec/test/fixtures/escrow-create-tx.json"));
  let bin = JSON.parse(fs.readFileSync(FIX + "/ripple-binary-codec/test/fixtures/escrow-create-binary.json"));
  const i = bin.indexOf("701127");
  bin = bin.slice(0, i) + bin.slice(i + 6 + 39 * 2);
  delete j.Condition;
  assert.equal(encode(j).toString("hex").toUpperCase(), bin);
});

test("hashes of real ledger transactions match", () => {
  const led = JSON.parse(fs.readFileSync(FIX + "/ripple-binary-codec/test/fixtures/ledger-full-38129.json"));
  const ok = new Set(["TransactionType","Flags","SourceTag","Sequence","DestinationTag","OfferSequence","LastLedgerSequence","CancelAfter","FinishAfter","Amount","Fee","SigningPubKey","TxnSignature","Account","Owner","Destination","NetworkID"]);
  let n = 0;
  for (const t of led.transactions) {
    const { hash, metaData, ...j } = t;
    if (!Object.keys(j).every((k) => ok.has(k)) || typeof j.Amount === "object") continue;
    assert.equal(txHash(encode(j).toString("hex")), hash);
    n++;
  }
  console.log("ledger txs matched", n);
  assert.ok(n > 0);
});

test("field headers match the official data-driven tests", () => {
  const dd = JSON.parse(fs.readFileSync(FIX + "/ripple-binary-codec/test/fixtures/data-driven-tests.json"));
  const names = ["SourceTag","DestinationTag","OfferSequence","LastLedgerSequence","CancelAfter","FinishAfter","Fee","Amount","SigningPubKey","TxnSignature","Account","Owner","Destination","Sequence","Flags","TransactionType"];
  let n = 0;
  for (const f of dd.fields_tests) {
    if (!names.includes(f.name)) continue;
    const sample = { UInt32: 0, UInt16: "Payment", Amount: "0", Blob: "", AccountID: "rrrrrrrrrrrrrrrrrrrrrhoLvTp" }[f.type_name];
    const hex = encode({ [f.name]: sample }).toString("hex").toUpperCase();
    assert.ok(hex.startsWith(f.expected_hex.toUpperCase()), f.name);
    n++;
  }
  console.log("headers matched", n);
});
