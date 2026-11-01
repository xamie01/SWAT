use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        msg!("Error: Instruction data empty");
        return Err(ProgramError::InvalidInstructionData);
    }

    let tag = instruction_data[0];
    let account_info_iter = &mut accounts.iter();

    match tag {
        // Tag 0: Authorized withdrawal by PDA Creator
        0 => {
            let owner_info = next_account_info(account_info_iter)?;
            let vault_info = next_account_info(account_info_iter)?;
            let destination_info = next_account_info(account_info_iter)?;
            let system_program_info = next_account_info(account_info_iter)?;

            // 1. Verify owner is signer
            if !owner_info.is_signer {
                msg!("Security Violation: Creator signature required!");
                return Err(ProgramError::MissingRequiredSignature);
            }

            // 2. Destination must be owner
            if destination_info.key != owner_info.key {
                msg!("Security Violation: Funds can only be returned to creator wallet!");
                return Err(ProgramError::InvalidAccountData);
            }

            // 3. Mathematical PDA derivation check
            let (expected_pda, bump) = Pubkey::find_program_address(
                &[b"vault", owner_info.key.as_ref()],
                program_id,
            );
            if *vault_info.key != expected_pda {
                msg!("Security Violation: Provided vault account does not match seeds [b\"vault\", owner]!");
                return Err(ProgramError::InvalidSeeds);
            }

            // 4. Extract amount
            if instruction_data.len() < 9 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let amount = u64::from_le_bytes(instruction_data[1..9].try_into().unwrap());
            if amount == 0 {
                return Err(ProgramError::InvalidArgument);
            }

            let vault_lamports = vault_info.lamports();
            if vault_lamports < amount {
                msg!("Error: Insufficient lamports in vault: {} < {}", vault_lamports, amount);
                return Err(ProgramError::InsufficientFunds);
            }

            msg!("Authorized Withdrawal: Transferring {} lamports to creator {}", amount, owner_info.key);

            let seeds: &[&[u8]] = &[b"vault", owner_info.key.as_ref(), &[bump]];
            invoke_signed(
                &system_instruction::transfer(vault_info.key, destination_info.key, amount),
                &[vault_info.clone(), destination_info.clone(), system_program_info.clone()],
                &[seeds],
            )?;

            msg!("Authorized Withdrawal successful!");
            Ok(())
        }

        // Tag 1: Unauthorized Withdrawal attempt by Attacker (Strictly fails)
        1 => {
            let attacker_info = next_account_info(account_info_iter)?;
            let vault_info = next_account_info(account_info_iter)?;

            if !attacker_info.is_signer {
                msg!("Attacker failed: Missing signer");
                return Err(ProgramError::MissingRequiredSignature);
            }

            // Attacker seeds derive a completely different address
            let (attacker_pda, _bump) = Pubkey::find_program_address(
                &[b"vault", attacker_info.key.as_ref()],
                program_id,
            );

            if *vault_info.key != attacker_pda {
                msg!("ATTACK BLOCKED: Attacker PDA {} does not match target Vault {}", attacker_pda, vault_info.key);
                msg!("Security Guardrail Enforced: Seed constraint [b\"vault\", caller] violated!");
                return Err(ProgramError::InvalidSeeds);
            }

            msg!("Anomaly: Attacker owns this vault");
            Err(ProgramError::Custom(0x999))
        }

        _ => {
            msg!("Error: Unknown instruction tag {}", tag);
            Err(ProgramError::InvalidInstructionData)
        }
    }
}
