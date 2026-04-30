/**
 * Zero-Downtime Migration: Enhanced User Profile System
 * 
 * This migration adds comprehensive user profile capabilities while maintaining
 * zero-downtime and backwards compatibility.
 * 
 * Migration Strategy:
 * Phase 1: Add new profile tables (non-breaking)
 * Phase 2: Backfill existing user data in batches
 * Phase 3: Create indexes and constraints
 * Phase 4: Update application to use new profile system
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function(knex) {
  console.log('[Migration 018] Starting zero-downtime user profile migration...');
  
  try {
    // Phase 1: Add new profile tables (non-breaking)
    await phase1_CreateProfileTables(knex);
    
    // Phase 2: Backfill existing user data
    await phase2_BackfillUserData(knex);
    
    // Phase 3: Create indexes and constraints
    await phase3_CreateIndexesAndConstraints(knex);
    
    console.log('[Migration 018] User profile migration completed successfully');
  } catch (error) {
    console.error('[Migration 018] Migration failed:', error);
    throw error;
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function(knex) {
  console.log('[Migration 018] Rolling back user profile migration...');
  
  try {
    // Reverse phases
    await rollbackPhase3_CreateIndexesAndConstraints(knex);
    await rollbackPhase2_BackfillUserData(knex);
    await rollbackPhase1_CreateProfileTables(knex);
    
    console.log('[Migration 018] Rollback completed');
  } catch (error) {
    console.error('[Migration 018] Rollback failed:', error);
    throw error;
  }
};

/**
 * Phase 1: Create new profile tables (always non-breaking)
 */
async function phase1_CreateProfileTables(knex) {
  console.log('[Migration 018] Phase 1: Creating profile tables...');
  
  // Create user_profiles table
  const hasUserProfiles = await knex.schema.hasTable('user_profiles');
  if (!hasUserProfiles) {
    await knex.schema.createTable('user_profiles', (table) => {
      table.increments('id').primary();
      table.string('user_id').notNullable().unique(); // References creator.wallet_address
      table.string('display_name').nullable();
      table.text('bio').nullable();
      table.string('avatar_url').nullable();
      table.string('website_url').nullable();
      table.string('twitter_handle').nullable();
      table.string('github_username').nullable();
      table.string('discord_username').nullable();
      table.json('social_links').nullable(); // For additional social platforms
      table.json('preferences').nullable(); // User preferences
      table.string('theme').defaultTo('light'); // light, dark, auto
      table.boolean('email_notifications').defaultTo(true);
      table.boolean('push_notifications').defaultTo(false);
      table.string('language').defaultTo('en');
      table.string('timezone').defaultTo('UTC');
      table.boolean('profile_public').defaultTo(true);
      table.boolean('show_email').defaultTo(false);
      table.boolean('show_social_links').defaultTo(true);
      table.integer('profile_views').defaultTo(0);
      table.timestamp('last_profile_update').nullable();
      table.timestamps(true, true);
      
      // Indexes for performance
      table.index(['user_id'], 'idx_user_profiles_user_id');
      table.index(['profile_public'], 'idx_user_profiles_public');
      table.index(['last_profile_update'], 'idx_user_profiles_last_update');
    });
    console.log('[Migration 018] Created user_profiles table');
  }

  // Create user_profile_settings table for granular settings
  const hasProfileSettings = await knex.schema.hasTable('user_profile_settings');
  if (!hasProfileSettings) {
    await knex.schema.createTable('user_profile_settings', (table) => {
      table.increments('id').primary();
      table.string('user_id').notNullable();
      table.string('setting_key').notNullable();
      table.text('setting_value').nullable();
      table.string('setting_type').defaultTo('string'); // string, number, boolean, json
      table.timestamps(true, true);
      
      // Composite index
      table.index(['user_id', 'setting_key'], 'idx_profile_settings_composite');
      
      // Unique constraint
      table.unique(['user_id', 'setting_key'], 'uq_profile_settings_user_key');
    });
    console.log('[Migration 018] Created user_profile_settings table');
  }

  // Create user_profile_activity_log table
  const hasActivityLog = await knex.schema.hasTable('user_profile_activity_log');
  if (!hasActivityLog) {
    await knex.schema.createTable('user_profile_activity_log', (table) => {
      table.increments('id').primary();
      table.string('user_id').notNullable();
      table.string('activity_type').notNullable(); // profile_update, view, follow, etc.
      table.json('activity_data').nullable(); // Details about the activity
      table.string('ip_address').nullable();
      table.string('user_agent').nullable();
      table.timestamp('activity_timestamp').defaultTo(knex.fn.now());
      
      // Indexes for querying
      table.index(['user_id'], 'idx_activity_log_user_id');
      table.index(['activity_type'], 'idx_activity_log_type');
      table.index(['activity_timestamp'], 'idx_activity_log_timestamp');
    });
    console.log('[Migration 018] Created user_profile_activity_log table');
  }

  console.log('[Migration 018] Phase 1 completed');
}

/**
 * Phase 2: Backfill existing user data in batches
 */
async function phase2_BackfillUserData(knex) {
  console.log('[Migration 018] Phase 2: Backfilling user data...');
  
  const BATCH_SIZE = 500; // Smaller batches for user data
  const DELAY_MS = 100;
  
  let offset = 0;
  let processedCount = 0;
  
  while (true) {
    // Get batch of creators that don't have profiles yet
    const batch = await knex('creators')
      .leftJoin('user_profiles', 'creators.wallet_address', 'user_profiles.user_id')
      .whereNull('user_profiles.user_id')
      .select('creators.*')
      .limit(BATCH_SIZE)
      .offset(offset);
    
    if (batch.length === 0) {
      console.log(`[Migration 018] Backfill complete. Processed ${processedCount} users`);
      break;
    }
    
    // Create profiles for this batch
    const profilePromises = batch.map(creator => 
      createUserProfile(knex, creator)
    );
    
    await Promise.all(profilePromises);
    processedCount += batch.length;
    offset += BATCH_SIZE;
    
    console.log(`[Migration 018] Backfilled ${processedCount} user profiles...`);
    
    // Small delay to allow normal traffic
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }
  
  console.log('[Migration 018] Phase 2 completed');
}

/**
 * Phase 3: Create additional indexes and constraints
 */
async function phase3_CreateIndexesAndConstraints(knex) {
  console.log('[Migration 018] Phase 3: Creating indexes and constraints...');
  
  // Create full-text search index for profiles
  await knex.raw(`
    CREATE VIRTUAL TABLE IF NOT EXISTS user_profiles_fts 
    USING fts5(user_id, display_name, bio, content='user_profiles', content_rowid='id')
  `);
  
  // Create triggers for full-text search
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS user_profiles_fts_insert 
    AFTER INSERT ON user_profiles 
    BEGIN
      INSERT INTO user_profiles_fts(rowid, user_id, display_name, bio)
      VALUES (new.id, new.user_id, new.display_name, new.bio);
    END
  `);
  
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS user_profiles_fts_delete 
    AFTER DELETE ON user_profiles 
    BEGIN
      DELETE FROM user_profiles_fts WHERE rowid = old.id;
    END
  `);
  
  await knex.raw(`
    CREATE TRIGGER IF NOT EXISTS user_profiles_fts_update 
    AFTER UPDATE ON user_profiles 
    BEGIN
      DELETE FROM user_profiles_fts WHERE rowid = old.id;
      INSERT INTO user_profiles_fts(rowid, user_id, display_name, bio)
      VALUES (new.id, new.user_id, new.display_name, new.bio);
    END
  `);
  
  // Add foreign key constraint (SQLite doesn't support adding FK to existing tables easily)
  // This would be handled in a separate migration or during table creation
  
  console.log('[Migration 018] Phase 3 completed');
}

/**
 * Create user profile for a creator
 */
async function createUserProfile(knex, creator) {
  const profileData = {
    user_id: creator.wallet_address,
    display_name: creator.name || creator.wallet_address.substring(0, 8) + '...',
    bio: null, // Will be filled later by user
    avatar_url: null, // Will be filled later by user
    website_url: null,
    twitter_handle: null,
    github_username: null,
    discord_username: null,
    social_links: {},
    preferences: {},
    theme: 'light',
    email_notifications: true,
    push_notifications: false,
    language: 'en',
    timezone: 'UTC',
    profile_public: true,
    show_email: false,
    show_social_links: true,
    profile_views: 0,
    last_profile_update: knex.fn.now(),
    created_at: creator.created_at || knex.fn.now(),
    updated_at: knex.fn.now()
  };

  // Insert profile
  await knex('user_profiles').insert(profileData);

  // Create default settings
  const defaultSettings = [
    { key: 'auto_follow', value: 'true', type: 'boolean' },
    { key: 'show_online_status', value: 'true', type: 'boolean' },
    { key: 'email_frequency', value: 'weekly', type: 'string' },
    { key: 'content_privacy', value: 'public', type: 'string' },
    { key: 'analytics_opt_in', value: 'false', type: 'boolean' }
  ];

  const settingsPromises = defaultSettings.map(setting =>
    knex('user_profile_settings').insert({
      user_id: creator.wallet_address,
      setting_key: setting.key,
      setting_value: setting.value,
      setting_type: setting.type,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now()
    })
  );

  await Promise.all(settingsPromises);

  // Log profile creation
  await knex('user_profile_activity_log').insert({
    user_id: creator.wallet_address,
    activity_type: 'profile_created',
    activity_data: JSON.stringify({
      source: 'migration',
      creator_id: creator.id
    }),
    activity_timestamp: knex.fn.now()
  });
}

/**
 * Rollback functions
 */
async function rollbackPhase3_CreateIndexesAndConstraints(knex) {
  console.log('[Migration 018] Rolling back Phase 3...');
  
  // Drop triggers
  await knex.raw('DROP TRIGGER IF EXISTS user_profiles_fts_insert');
  await knex.raw('DROP TRIGGER IF EXISTS user_profiles_fts_delete');
  await knex.raw('DROP TRIGGER IF EXISTS user_profiles_fts_update');
  
  // Drop full-text search table
  await knex.raw('DROP TABLE IF EXISTS user_profiles_fts');
  
  console.log('[Migration 018] Phase 3 rollback completed');
}

async function rollbackPhase2_BackfillUserData(knex) {
  console.log('[Migration 018] Rolling back Phase 2...');
  // Data backfill is not reversible - just clean up activity logs
  await knex('user_profile_activity_log')
    .where('activity_type', 'profile_created')
    .where('activity_data', 'like', '%"source":"migration"%')
    .del();
  
  console.log('[Migration 018] Phase 2 rollback completed');
}

async function rollbackPhase1_CreateProfileTables(knex) {
  console.log('[Migration 018] Rolling back Phase 1...');
  
  // Drop tables in reverse order
  await knex.schema.dropTableIfExists('user_profile_activity_log');
  await knex.schema.dropTableIfExists('user_profile_settings');
  await knex.schema.dropTableIfExists('user_profiles');
  
  console.log('[Migration 018] Phase 1 rollback completed');
}
