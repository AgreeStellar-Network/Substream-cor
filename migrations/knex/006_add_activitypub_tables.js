exports.up = function(knex) {
  return knex.schema
    // ActivityPub actors table
    .createTable('activitypub_actors', function(table) {
      table.string('creator_address').primary().references('id').inTable('creators').onDelete('CASCADE');
      table.text('public_key').notNullable();
      table.text('private_key').notNullable();
      table.string('actor_id').notNullable().unique();
      table.string('inbox_url').notNullable();
      table.string('outbox_url').notNullable();
      table.string('followers_url').notNullable();
      table.string('following_url').notNullable();
      table.boolean('federation_enabled').defaultTo(true);
      table.json('actor_profile');
      table.timestamps(true, true);
    })
    
    // ActivityPub followers table
    .createTable('activitypub_followers', function(table) {
      table.increments('id').primary();
      table.string('creator_address').notNullable().references('id').inTable('creators').onDelete('CASCADE');
      table.string('follower_actor').notNullable();
      table.string('follower_inbox');
      table.string('follower_shared_inbox');
      table.string('follow_activity_id').notNullable();
      table.boolean('active').defaultTo(true);
      table.timestamp('followed_at').defaultTo(knex.fn.now());
      table.timestamp('last_activity_at').defaultTo(knex.fn.now());
      table.json('follower_data');
      
      table.index(['creator_address', 'active']);
      table.index(['follower_actor']);
    })
    
    // ActivityPub activities table (sent activities)
    .createTable('activitypub_activities', function(table) {
      table.increments('id').primary();
      table.string('creator_address').notNullable().references('id').inTable('creators').onDelete('CASCADE');
      table.string('activity_id').notNullable().unique();
      table.string('activity_type').notNullable();
      table.string('object_type').notNullable();
      table.string('object_id').notNullable(); // content_id, etc.
      table.json('activity_data').notNullable();
      table.string('status').defaultTo('pending'); // pending, sent, failed
      table.text('error_message');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('sent_at');
      
      table.index(['creator_address', 'status']);
      table.index(['object_id']);
    })
    
    // ActivityPub engagements table (received activities)
    .createTable('activitypub_engagements', function(table) {
      table.increments('id').primary();
      table.string('creator_address').notNullable().references('id').inTable('creators').onDelete('CASCADE');
      table.string('activity_type').notNullable();
      table.string('activity_actor').notNullable();
      table.string('activity_id').notNullable();
      table.string('object_id');
      table.string('object_type');
      table.json('activity_data').notNullable();
      table.timestamp('received_at').defaultTo(knex.fn.now());
      
      table.index(['creator_address', 'activity_type']);
      table.index(['activity_actor']);
    })
    
    // Federation queue table (for background processing)
    .createTable('federation_queue', function(table) {
      table.increments('id').primary();
      table.string('creator_address').notNullable().references('id').inTable('creators').onDelete('CASCADE');
      table.string('content_id').notNullable().references('id').inTable('content').onDelete('CASCADE');
      table.string('activity_type').notNullable().defaultTo('Announce');
      table.json('activity_data').notNullable();
      table.string('status').defaultTo('pending'); // pending, processing, completed, failed
      table.text('error_message');
      table.integer('retry_count').defaultTo(0);
      table.timestamp('scheduled_at').defaultTo(knex.fn.now());
      table.timestamp('processed_at');
      
      table.index(['status', 'scheduled_at']);
      table.index(['creator_address', 'content_id']);
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('federation_queue')
    .dropTableIfExists('activitypub_engagements')
    .dropTableIfExists('activitypub_activities')
    .dropTableIfExists('activitypub_followers')
    .dropTableIfExists('activitypub_actors');
};
