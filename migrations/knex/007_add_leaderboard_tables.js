exports.up = function(knex) {
  return knex.schema
    // Streaming payments table for tracking fan payments
    .createTable('streaming_payments', function(table) {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('creator_address').notNullable().index();
      table.string('fan_address').notNullable().index();
      table.decimal('amount', 20, 8).notNullable();
      table.string('currency').defaultTo('XLM');
      table.string('transaction_hash').unique();
      table.timestamp('created_at').defaultTo(knex.fn.now()).index();
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Indexes for performance
      table.index(['creator_address', 'fan_address']);
      table.index(['creator_address', 'created_at']);
      table.index(['fan_address', 'created_at']);
    })
    
    // Content likes table for engagement tracking
    .createTable('content_likes', function(table) {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('content_id').notNullable().index();
      table.string('creator_address').notNullable().index();
      table.string('fan_address').notNullable().index();
      table.timestamp('created_at').defaultTo(knex.fn.now()).index();
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Unique constraint to prevent duplicate likes
      table.unique(['content_id', 'fan_address']);
      
      // Indexes for performance
      table.index(['creator_address', 'fan_address']);
      table.index(['creator_address', 'created_at']);
    })
    
    // Leaderboard snapshots for historical data
    .createTable('leaderboard_snapshots', function(table) {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('creator_address').notNullable().index();
      table.string('fan_address').notNullable().index();
      table.string('season').notNullable().index();
      table.integer('rank').notNullable();
      table.decimal('score', 10, 2).notNullable();
      table.json('metrics'); // Detailed metrics snapshot
      table.timestamp('calculated_at').defaultTo(knex.fn.now()).index();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      
      // Indexes for performance
      table.index(['creator_address', 'season']);
      table.index(['creator_address', 'season', 'rank']);
      table.index(['fan_address', 'season']);
    })
    
    // Fan engagement summary for quick lookups
    .createTable('fan_engagement_summary', function(table) {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('creator_address').notNullable().index();
      table.string('fan_address').notNullable().index();
      table.string('season').notNullable().index();
      
      // Aggregated metrics
      table.decimal('total_streaming_amount', 20, 8).defaultTo(0);
      table.integer('streaming_transaction_count').defaultTo(0);
      table.integer('streaming_days').defaultTo(0);
      table.integer('subscription_days').defaultTo(0);
      table.integer('current_streak').defaultTo(0);
      table.boolean('subscription_active').defaultTo(false);
      table.integer('comment_count').defaultTo(0);
      table.integer('like_count').defaultTo(0);
      table.integer('share_count').defaultTo(0);
      table.integer('total_engagement').defaultTo(0);
      
      // Calculated fields
      table.decimal('streaming_score', 5, 2).defaultTo(0);
      table.decimal('subscription_score', 5, 2).defaultTo(0);
      table.decimal('engagement_score', 5, 2).defaultTo(0);
      table.decimal('composite_score', 5, 2).defaultTo(0);
      
      table.timestamp('last_calculated').defaultTo(knex.fn.now()).index();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Unique constraint for season-based data
      table.unique(['creator_address', 'fan_address', 'season']);
      
      // Indexes for performance
      table.index(['creator_address', 'season', 'composite_score']);
      table.index(['fan_address', 'season', 'composite_score']);
    })
    
    // Update creators table to include leaderboard preferences
    .table('creators', function(table) {
      table.boolean('leaderboard_enabled').defaultTo(true);
      table.json('leaderboard_settings'); // Custom weights, season length, etc.
      table.timestamp('last_leaderboard_update').defaultTo(knex.fn.now());
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('fan_engagement_summary')
    .dropTableIfExists('leaderboard_snapshots')
    .dropTableIfExists('content_likes')
    .dropTableIfExists('streaming_payments')
    .table('creators', function(table) {
      table.dropColumn('leaderboard_enabled');
      table.dropColumn('leaderboard_settings');
      table.dropColumn('last_leaderboard_update');
    });
};
