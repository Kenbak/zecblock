'use strict';
// Single source for the research SQL function allowlist: the server policy
// enforces it and the workbench lists it.
const functions=Object.freeze('count sum avg min max round abs ceil ceiling floor trunc sqrt mod greatest least coalesce nullif date_trunc date_part extract to_timestamp to_char lower upper length substring substr left right trim btrim ltrim rtrim row_number rank dense_rank lag lead first_value last_value nth_value ntile percent_rank cume_dist stddev_samp stddev_pop variance var_samp var_pop'.split(' '));
module.exports={functions};
